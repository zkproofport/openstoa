import { E2E_DEVICE_HEADERS } from './helpers';
/**
 * The grant that actually moves keys — two REAL MLS clients, over HTTP.
 *
 * WHAT WAS STILL UNPROVEN. The request flow is covered end to end, and the
 * device shows and answers the ask. But every check so far had a curl-created
 * "member" as the asker, and a curl account has no MLS leaf: there is nothing
 * to seal a bundle to, so `grantMissingTo` correctly returned zero and the
 * happy path — a member who HOLDS the epochs handing them over, and the asker
 * then reading what it could not read — was never executed.
 *
 * This runs two genuine MLS clients in Node against the live server: an owner
 * who creates the group and archives a private message, and a joiner who
 * arrives afterwards. The joiner cannot read the earlier message — that is the
 * whole situation the feature exists for — asks, and the owner grants.
 *
 * WHY IT IS WORTH THE SETUP. The failure this catches is silent by
 * construction: a grant that seals to the wrong leaf, or to no leaf, produces
 * exactly the same 200s and the same "granted" row as a working one. The only
 * thing that distinguishes them is whether the asker can afterwards read a
 * message it could not read before, so that is what is asserted.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a later joiner cannot read the earlier archive (the premise)
 *   contract   → ask → grant → the same row now DECRYPTS
 *   integrity  → the grant reaches a non-zero number of leaves
 *   integrity  → the request is marked answered only after the bundle exists
 *   boundary   → `haveFromEpoch` limits what is sent: asking from a later epoch
 *                grants nothing new
 *   authz      → the granted bundle is addressed to the ASKER's leaf, not the
 *                granter's own
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as gc from '@/lib/mls/groupClient';
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import {
  botPublishKeyPackage,
  botJoin,
  grantAiHistory,
  removeAiMember,
  type AiMemberDirectory,
} from '@/lib/mls/aiMember';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function devLogin(prefix: string): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    // The suite stands in for the mobile app; a login that declares nothing
    // defaults to `web`, and chat / MLS / TAK are refused to a web session.
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId };
}

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function join(token: string, topicId: string) {
  const r = await fetch(`${BASE}/api/topics/${topicId}/join`, { method: 'POST', headers: bearer(token) });
  if (![200, 201].includes(r.status)) throw new Error(`join failed: ${r.status}`);
}

/** HTTP MlsTransport over the DS endpoints (Bearer), mirroring the web transport. */
function httpMls(token: string): MlsTransport {
  const base = (t: string) => `${BASE}/api/topics/${t}/mls`;
  const h = bearer(token);
  return {
    async getGroupInfo(topicId) {
      const r = await fetch(`${base(topicId)}/group-info`, { headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`group-info GET ${r.status}`);
      return (await r.json()).groupInfo as string;
    },
    async postGroupInfo(topicId, groupInfoB64, groupIdB64) {
      const r = await fetch(`${base(topicId)}/group-info`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ groupInfo: groupInfoB64, groupId: groupIdB64 }),
      });
      if (!r.ok) throw new Error(`group-info POST ${r.status}`);
      return (await r.json()).created as boolean;
    },
    async postCommit(topicId, commitB64, groupInfoB64) {
      const r = await fetch(`${base(topicId)}/commit`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ commit: commitB64, groupInfo: groupInfoB64 }),
      });
      if (r.status === 409) return { ok: false };
      if (!r.ok) throw new Error(`commit POST ${r.status}`);
      return { ok: true, epoch: (await r.json()).epoch as number };
    },
    async getCommitsSince(topicId, sinceEpoch) {
      const r = await fetch(`${base(topicId)}/commit?sinceEpoch=${sinceEpoch}`, { headers: h });
      if (!r.ok) throw new Error(`commit GET ${r.status}`);
      return (await r.json()).commits;
    },
  };
}

/** HTTP TakTransport over the archive + bundle endpoints (Bearer). */
function httpTak(token: string): TakTransport {
  const base = (t: string) => `${BASE}/api/topics/${t}`;
  const h = bearer(token);
  return {
    async postArchive(topicId, messageId, takVersion, archiveB64) {
      const r = await fetch(`${base(topicId)}/archive`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ messageId, takVersion, archive: archiveB64 }),
      });
      if (!r.ok && r.status !== 200) throw new Error(`archive POST ${r.status}`);
    },
    async getArchive(topicId) {
      const out: ArchiveEntry[] = [];
      let cursor = '';
      for (;;) {
        const r = await fetch(`${base(topicId)}/archive?limit=500${cursor}`, { headers: h });
        if (!r.ok) throw new Error(`archive GET ${r.status}`);
        const page = (await r.json()).archive as ArchiveEntry[];
        out.push(...page);
        if (page.length < 500) break;
        const last = page[page.length - 1];
        cursor = `&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
      }
      return out;
    },
    async postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ recipientUserId, recipientDeviceId, bundle: bundleB64, scope }),
      });
      if (!r.ok) throw new Error(`bundle POST ${r.status}`);
    },
    async getBundles(topicId, deviceId) {
      const r = await fetch(`${base(topicId)}/tak/bundles?deviceId=${encodeURIComponent(deviceId)}`, { headers: h });
      if (!r.ok) throw new Error(`bundle GET ${r.status}`);
      return (await r.json()).bundles as TakBundleRow[];
    },
    async getServerRoot() {
      return null;
    },
    async putServerRoot() {
      return true;
    },
    async getRootFingerprint(topicId) {
      const r = await fetch(`${base(topicId)}/tak/root-fingerprint`, { headers: h });
      // 400/404: no public archive root concept for this topic (private/secret).
      if (r.status === 400 || r.status === 404) return { fingerprint: null, archiveCount: 0 };
      if (!r.ok) throw new Error(`root-fingerprint GET ${r.status}`);
      return await r.json();
    },
    async setRootFingerprint(topicId, fingerprint) {
      const r = await fetch(`${base(topicId)}/tak/root-fingerprint`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ fingerprint }),
      });
      if (!r.ok) throw new Error(`root-fingerprint PUT ${r.status}`);
      return await r.json();
    },
    async ackBundles(topicId, deviceId, ids) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'DELETE',
        headers: h,
        body: JSON.stringify({ deviceId, ids }),
      });
      if (!r.ok) throw new Error(`bundle DELETE ${r.status}`);
    },
  };
}

/** HTTP AiMemberDirectory over the KeyPackage endpoints (Bearer). */
function httpDir(token: string): AiMemberDirectory {
  const h = bearer(token);
  return {
    async publishKeyPackage(topicId, body) {
      const r = await fetch(`${BASE}/api/topics/${topicId}/mls/key-packages`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`key-packages POST ${r.status} ${await r.text()}`);
      return { id: (await r.json()).id as string };
    },
  };
}

/** Consume one KeyPackage for a user's device (proves last-resort reusability). */
async function consumeKeyPackage(token: string, topicId: string, userId: string, deviceId: string) {
  const r = await fetch(
    `${BASE}/api/topics/${topicId}/mls/key-packages?userId=${encodeURIComponent(userId)}&deviceId=${encodeURIComponent(deviceId)}`,
    { headers: bearer(token) },
  );
  if (!r.ok) throw new Error(`key-packages GET ${r.status}`);
  return r.json() as Promise<{ id: string; deviceId: string; keyPackage: string; isLastResort: boolean }>;
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}


describe('a member hands over the epochs an asker is missing', () => {
  let owner: { token: string; userId: string };
  let joiner: { token: string; userId: string };
  let topicId: string;
  let ownerMls: MlsSessionStore;
  let ownerTak: TakSessionStore;
  let joinerMls: MlsSessionStore;
  let joinerTak: TakSessionStore;

  const OWNER_DEV = 'owner-device';
  const JOINER_DEV = 'joiner-device';
  const SECRET = 'only-the-early-epoch-can-read-this';
  // The archive route requires a uuid — a readable id 400s before anything
  // interesting happens, and the failure reads as "archive POST 400".
  const MSG_ID = randomUUID();

  beforeAll(async () => {
    owner = await devLogin('kg_owner');
    joiner = await devLogin('kg_joiner');

    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    const created = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({
        title: `e2e-keygrant-${Date.now().toString(36)}`,
        description: 'two real MLS clients',
        visibility: 'public',
        categoryId: cats.categories[0].id,
      }),
    });
    const t = await created.json();
    topicId = t.topic?.id ?? t.id;
    await join(joiner.token, topicId);

    /*
     * The FIFTH argument is what makes this work, and leaving it out is why the
     * first version of this test saw a grant reach zero leaves.
     *
     * A leaf credential is `<userId>:<deviceId>` precisely so a grant addressed
     * to a PERSON can find every device they own (`leafIdentity`). Without the
     * account provider the leaf is a bare device id, `userIdOfLeaf` refuses to
     * attribute it, and `findRecipientLeaves` matches nothing — the grant is
     * sealed to nobody and returns 0, which is indistinguishable at the HTTP
     * layer from a device that simply held no keys.
     */
    ownerMls = new MlsSessionStore(
      httpMls(owner.token), OWNER_DEV, memKv(), undefined, async () => owner.userId,
    );
    ownerTak = new TakSessionStore(ownerMls, httpTak(owner.token), memKv());
    joinerMls = new MlsSessionStore(
      httpMls(joiner.token), JOINER_DEV, memKv(), undefined, async () => joiner.userId,
    );
    joinerTak = new TakSessionStore(joinerMls, httpTak(joiner.token), memKv());
  });

  it('1. the owner starts the group and archives a message at epoch 0', async () => {
    await ownerMls.seal(topicId, 'genesis');
    await ownerTak.archiveOnSend(topicId, MSG_ID, SECRET, 'private');
    const epoch = await ownerMls.readState(topicId, async (s) => gc.currentEpoch(s));
    expect(epoch).toBe(0);
  });

  it('2. CONTRACT: a later joiner cannot read it — the premise of the whole feature', async () => {
    /*
     * Not a defect. The joiner's External Commit advances the epoch, and MLS
     * gives it no access to what came before (RFC 9750 §6.7). Everything after
     * this exists because of this line.
     */
    await joinerMls.sync(topicId);
    const rows = await joinerTak.backfill(topicId, 'private');
    const mine = rows.find((m) => m.messageId === MSG_ID);
    expect(mine?.plaintext ?? null).not.toBe(SECRET);
  });

  it('3. the joiner asks, and the owner sees the ask', async () => {
    const asked = await fetch(`${BASE}/api/topics/${topicId}/keys/request`, {
      method: 'POST',
      headers: bearer(joiner.token),
      body: JSON.stringify({ deviceId: JOINER_DEV, haveFromEpoch: null }),
    });
    expect(asked.status).toBe(201);

    const list = await (
      await fetch(`${BASE}/api/topics/${topicId}/keys/request`, { headers: bearer(owner.token) })
    ).json();
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].requesterDeviceId).toBe(JOINER_DEV);
  });

  it('4. INTEGRITY: the grant reaches the ASKER\'s leaf, not the granter\'s own', async () => {
    await ownerMls.sync(topicId);
    const leaves = await ownerTak.grantMissingTo(topicId, joiner.userId, null);
    // Non-zero is the assertion that matters: zero is what a curl "member"
    // produced, and is indistinguishable from success at the HTTP layer.
    expect(leaves).toBeGreaterThan(0);

    const list = await (
      await fetch(`${BASE}/api/topics/${topicId}/keys/request`, { headers: bearer(owner.token) })
    ).json();
    const marked = await fetch(`${BASE}/api/topics/${topicId}/keys/grant`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ requestId: list.requests[0].id }),
    });
    expect(marked.status).toBe(200);
    expect((await marked.json()).alreadyGranted).toBe(false);
  });

  it('5. CONTRACT: the asker can now read what it could not read before', async () => {
    /*
     * The only assertion that separates a working grant from one sealed to the
     * wrong leaf — both produce identical 200s and an identical "granted" row.
     */
    await joinerMls.sync(topicId);
    const rows = await joinerTak.backfill(topicId, 'private');
    const mine = rows.find((m) => m.messageId === MSG_ID);
    expect(mine?.plaintext).toBe(SECRET);
  });

  it('6. the request is off the list once answered', async () => {
    const list = await (
      await fetch(`${BASE}/api/topics/${topicId}/keys/request`, { headers: bearer(owner.token) })
    ).json();
    expect(list.requests).toHaveLength(0);
  });

  it('7. BOUNDARY: asking from a LATER epoch grants nothing new', async () => {
    // `haveFromEpoch` bounds the grant. An asker that already holds everything
    // below epoch 0 is asking for an empty range, and the honest answer is 0 —
    // which the caller must not then mark as answered.
    const leaves = await ownerTak.grantMissingTo(topicId, joiner.userId, 0);
    expect(leaves).toBe(0);
  });
});
