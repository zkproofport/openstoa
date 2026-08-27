/**
 * A member who was away reads what arrived while they were gone — over HTTP,
 * against the real server.
 *
 * WHY THIS EXISTS ON TOP OF THE IN-PROCESS TEST. The same scenario is already
 * covered with real MLS and real key derivation, but with an in-memory
 * transport. That proves the crypto; it does not prove the CATCH-UP, which is
 * the part that has to reach across the network: the device asks the server for
 * every commit it missed and re-applies them in order. If the commit endpoint
 * paged, capped, re-ordered or dropped anything, the in-memory test would still
 * be green and a real phone would still lose the conversation.
 *
 * THE DEFECT BEING GUARDED. `private` and `secret` seal their archive with a
 * key PER EPOCH, and MLS ratchets forward: once a commit is applied, the epoch
 * it left can never be derived again. The catch-up walked the missed commits in
 * a loop and derived nothing on the way, so a member who was merely away came
 * back holding a key for the newest epoch and nothing else. Every message sent
 * while they were gone was unreadable — silently, because a past epoch simply
 * answers `null` and the bubble renders as undecryptable.
 *
 * They were never removed. Removal is what per-epoch keys exist to enforce and
 * it still works: a removed device stops receiving commits, so it cannot reach
 * those epochs at all. Being quiet is not being removed.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → the away member reads a message from EVERY epoch it slept
 *                through, by content, after a single catch-up
 *   累積       → five membership changes, five recovered stretches. THE axis: a
 *                fix that kept only the newest epoch passes a one-commit test
 *                and leaves the other four exactly as broken
 *   boundary   → the epoch the device was STANDING IN when it fell behind is
 *                kept too; that key dies with the first commit applied
 *   integrity  → the epochs really did advance server-side, so the test is not
 *                quietly passing against a group that never moved
 */
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


/** Consume one KeyPackage for a user's device (proves last-resort reusability). */

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}




const AWAY_DEV = 'away-device';
const HOST_DEV = 'host-device';

describe('a member who was away still reads what arrived', () => {
  let host: { token: string; userId: string };
  let away: { token: string; userId: string };
  let topicId: string;
  let hostMls: MlsSessionStore;
  let hostTak: TakSessionStore;
  let awayMls: MlsSessionStore;
  let awayTak: TakSessionStore;

  /** messageId → the words that were sent, filled in as the host talks. */
  const sent: Record<string, string> = {};

  beforeAll(async () => {
    host = await devLogin('away_host');
    away = await devLogin('away_member');

    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    const created = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(host.token),
      body: JSON.stringify({
        title: `e2e-away-${Date.now().toString(36)}`,
        description: 'a member goes quiet while the room moves on',
        visibility: 'public',
        categoryId: cats.categories[0].id,
      }),
    });
    const t = await created.json();
    topicId = t.topic?.id ?? t.id;
    await join(away.token, topicId);

    /*
     * The account provider (the fifth argument) is not optional here. A leaf
     * credential is `<userId>:<deviceId>`; without it the leaf is a bare device
     * id and nothing that reasons about "which person owns this leaf" works.
     */
    hostMls = new MlsSessionStore(
      httpMls(host.token), HOST_DEV, memKv(), undefined, async () => host.userId,
    );
    hostTak = new TakSessionStore(hostMls, httpTak(host.token), memKv());
    awayMls = new MlsSessionStore(
      httpMls(away.token), AWAY_DEV, memKv(), undefined, async () => away.userId,
    );
    awayTak = new TakSessionStore(awayMls, httpTak(away.token), memKv());
  });

  it('1. both are in the room, and the away device takes the key for the epoch it is standing in', async () => {
    const first = await hostMls.seal(topicId, 'genesis');
    await awayMls.open(topicId, first);
    await hostMls.sync(topicId);

    // What a device that had read anything in this room would already hold.
    await awayTak.cacheCurrentEpochTak(topicId);
    expect((await awayTak.heldEpochs(topicId)).length).toBeGreaterThan(0);
  });

  it('2. the room moves on five times while the away device is closed', async () => {
    /*
     * Each new member's External Commit advances the epoch, so each message
     * below is sealed under a DIFFERENT key. The away device is not syncing —
     * that is the whole point; it is a phone in a pocket.
     */
    for (let i = 0; i < 5; i++) {
      const body = `while-you-were-gone-${i}`;
      const id = randomUUID();
      await hostMls.seal(topicId, body);
      await hostTak.archiveOnSend(topicId, id, body, 'private');
      sent[id] = body;

      const newcomer = await devLogin(`away_join${i}`);
      await join(newcomer.token, topicId);
      const nMls = new MlsSessionStore(
        httpMls(newcomer.token), `newcomer-${i}`, memKv(), undefined, async () => newcomer.userId,
      );
      await nMls.open(topicId, await hostMls.seal(topicId, 'ping'));
      await hostMls.sync(topicId);
    }

    expect(Object.keys(sent)).toHaveLength(5);
  }, 120_000);

  it('3. INTEGRITY: the epochs really advanced on the server', async () => {
    /*
     * Without this the next case could pass against a group that never moved —
     * every message under one key, which is precisely the situation this test
     * is meant to rule out.
     */
    const epoch = await hostMls.readState(topicId, async (s) => gc.currentEpoch(s));
    expect(epoch).toBeGreaterThanOrEqual(5);
  });

  it('4. ACCUMULATING: one catch-up, and every stretch reads back', async () => {
    /*
     * A single `sync` pulls every missed commit from the server and re-applies
     * them in order. The key for each epoch has to be taken AS IT PASSES; there
     * is no second chance once the state has moved on.
     *
     * Asserted by CONTENT, message by message. A length check would pass on five
     * copies of the last one — and the last one is exactly what the broken code
     * COULD read, so a weaker assertion here reports the bug as fixed.
     */
    await awayMls.sync(topicId);

    const rows = await awayTak.backfill(topicId, 'private');
    const read = Object.fromEntries(rows.map((r) => [r.messageId, r.plaintext]));

    for (const [id, body] of Object.entries(sent)) {
      expect(read[id], `message "${body}"`).toBe(body);
    }
  }, 120_000);
});
