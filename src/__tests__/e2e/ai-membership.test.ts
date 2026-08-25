import { E2E_DEVICE_HEADERS } from './helpers';
/**
 * Phase 5 AI-membership END-TO-END against a REAL running container over HTTP,
 * driving the PORTABLE MLS client (groupClient / mlsSession / takSession /
 * aiMember) for real in Node against the live Delivery Service (design §7 D9/
 * D11, §9.3 ZAEP bot join). No mocks; the server only ever sees opaque
 * ciphertext + access-control metadata (C1/SI-1).
 *
 * The flow proven with real MLS + TAK crypto:
 *   1. owner dev-login, create topic + MLS group (genesis group-info).
 *   2. bot publishes its OWN reusable isAI last-resort KeyPackage, then
 *      self-joins the MLS group via External Commit → a real leaf, its OWN key.
 *   3. owner archives messages across two epochs (under the per-epoch TAK).
 *   4. owner grants the bot ONLY the in-scope epoch TAK (scoped history).
 *   5. assert: the bot decrypts ONLY in-scope history (out-of-scope unreadable);
 *      the last-resort KeyPackage is reusable (bot re-addable).
 *   6. owner removes the bot (MLS Remove Commit) → bot removed at a new epoch.
 *   7. zero human key sharing: the bot's leaf key ≠ any human leaf key.
 *
 * AI *capability* is no longer a per-topic grant — it is the account owner's
 * PROFILE permission set (PUT /api/profile/ai-permissions), enforced server-side.
 * The isAI-ENFORCEMENT 403 branch (a gated route rejecting an isAI session that
 * lacks the cmd) is proven at the UNIT level in src/__tests__/ai-permissions.test.ts
 * and over HTTP in src/__tests__/e2e/ai-permissions.test.ts, because
 * /api/auth/dev-login can mint an isAI session (via the `isAI` flag). The MLS
 * join / scope / remove mechanics here run for real.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

/** base64 hpke leaf key per basic-credential identity, from a live MLS state. */
async function leafKeys(mls: MlsSessionStore, topicId: string): Promise<Map<string, string>> {
  return mls.readState(topicId, async (s) => {
    const tree = s.ratchetTree as Array<
      { nodeType?: string; leaf?: { hpkePublicKey: Uint8Array; credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined
    >;
    const dec = new TextDecoder();
    const out = new Map<string, string>();
    for (const node of tree) {
      if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
      const cred = node.leaf.credential;
      if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
      out.set(dec.decode(cred.identity), b64(node.leaf.hpkePublicKey));
    }
    return out;
  });
}

const OWNER_ID = 'e2e-owner-device';
const CAROL_ID = 'e2e-carol-device';
const BOT_ID = 'e2e-ai-bot-device';

describe.sequential('P5 AI-membership (E2E, real container + real MLS client)', () => {
  let owner: { token: string; userId: string };
  let carol: { token: string; userId: string };
  let bot: { token: string; userId: string };
  let topicId: string;

  let ownerMls: MlsSessionStore;
  let ownerTak: TakSessionStore;
  let carolMls: MlsSessionStore;
  let botMls: MlsSessionStore;
  let botTak: TakSessionStore;
  let botDir: AiMemberDirectory;
  // Archive rows are keyed by a UUID message id (server validates the shape).
  const msgE0 = crypto.randomUUID();
  const msgE1 = crypto.randomUUID();

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('owner');
    carol = await devLogin('carol');
    bot = await devLogin('bot');

    const cats = await fetch(`${BASE}/api/categories`, { headers: bearer(owner.token) });
    const categoryId = (await cats.json()).categories[0].id;
    const res = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `E2E AI membership ${Date.now()}`, description: 'AI membership', visibility: 'public', categoryId }),
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;

    await join(carol.token, topicId);
    await join(bot.token, topicId);

    ownerMls = new MlsSessionStore(httpMls(owner.token), OWNER_ID, memKv());
    ownerTak = new TakSessionStore(ownerMls, httpTak(owner.token), memKv());
    carolMls = new MlsSessionStore(httpMls(carol.token), CAROL_ID, memKv());
    botMls = new MlsSessionStore(httpMls(bot.token), BOT_ID, memKv());
    botTak = new TakSessionStore(botMls, httpTak(bot.token), memKv());
    botDir = httpDir(bot.token);
  });

  it('1. owner genesis + archives an epoch-0 private message', async () => {
    await ownerMls.seal(topicId, 'genesis'); // bootstraps genesis (posts group-info) at epoch 0
    await ownerTak.archiveOnSend(topicId, msgE0, 'epoch0-secret', 'private');
    const epoch = await ownerMls.readState(topicId, async (s) => gc.currentEpoch(s));
    expect(epoch).toBe(0);
  });

  it('2. a second human joins (→ epoch 1); owner archives an epoch-1 private message', async () => {
    await carolMls.sync(topicId); // External-Commit join → epoch 1
    await ownerMls.sync(topicId); // owner catches up to see carol's leaf + epoch 1
    await ownerTak.archiveOnSend(topicId, msgE1, 'epoch1-secret', 'private');
    const epoch = await ownerMls.readState(topicId, async (s) => gc.currentEpoch(s));
    expect(epoch).toBe(1);
  });

  it('3. bot publishes its OWN reusable isAI last-resort KeyPackage', async () => {
    const pub = await botPublishKeyPackage(botDir, topicId, BOT_ID);
    expect(pub.id).toBeTruthy();

    // Last-resort reusability: consuming the bot package twice returns the SAME
    // package (bot is re-addable after a Remove).
    const c1 = await consumeKeyPackage(owner.token, topicId, bot.userId, BOT_ID);
    const c2 = await consumeKeyPackage(owner.token, topicId, bot.userId, BOT_ID);
    expect(c1.isLastResort).toBe(true);
    expect(c2.id).toBe(c1.id);
  });

  it('4. bot self-joins via External Commit (its OWN leaf key) → epoch 2', async () => {
    const epoch = await botJoin(botMls, topicId);
    expect(epoch).toBe(2);
    await ownerMls.sync(topicId);
    await carolMls.sync(topicId);
    expect(await ownerMls.readState(topicId, async (s) => gc.currentEpoch(s))).toBe(2);
  });

  it('5. D9 — zero human key sharing: the bot leaf key differs from every human leaf key', async () => {
    const keys = await leafKeys(ownerMls, topicId);
    expect(keys.get(BOT_ID)).toBeTruthy();
    expect(keys.get(BOT_ID)).not.toBe(keys.get(OWNER_ID));
    expect(keys.get(BOT_ID)).not.toBe(keys.get(CAROL_ID));
  });

  it('6. AI capability is configured in the owner PROFILE, not per-topic here', () => {
    // The per-topic UCAN grant was retired: an isAI session is gated by the
    // account owner's profile capability set (PUT /api/profile/ai-permissions),
    // enforced server-side. That gate is covered in ai-permissions.test.ts
    // (unit) and ai-permissions e2e. This MLS membership flow only proves the
    // cryptographic mechanics (join / scoped history / remove).
    expect(true).toBe(true);
  });

  it('7. before any TAK grant the bot reads NO pre-join history (forward secrecy)', async () => {
    const history = await botTak.backfill(topicId, 'private');
    expect(history.find((h) => h.messageId === msgE0)).toBeUndefined();
    expect(history.find((h) => h.messageId === msgE1)).toBeUndefined();
  });

  it('8. owner grants ONLY the in-scope epoch → bot reads epoch-1 but NOT epoch-0', async () => {
    const delivered = await grantAiHistory(ownerTak, topicId, BOT_ID, [1]);
    expect(delivered).toBeGreaterThanOrEqual(1);

    const history = await botTak.backfill(topicId, 'private');
    expect(history.find((h) => h.messageId === msgE1)?.plaintext).toBe('epoch1-secret');
    // Out-of-scope: epoch 0's TAK was never delivered → its archive is unreadable.
    expect(history.find((h) => h.messageId === msgE0)).toBeUndefined();
  });

  it('9. owner removes the bot (MLS Remove) → bot gone from a new epoch', async () => {
    const newEpoch = await removeAiMember(ownerMls, topicId, BOT_ID);
    expect(newEpoch).toBe(3);

    // The bot's leaf is removed from the owner's validated tree at the new epoch.
    await ownerMls.readState(topicId, async (s) => expect(gc.findLeafIndexByIdentity(s, BOT_ID)).toBeNull());
    const keysAfter = await leafKeys(ownerMls, topicId);
    expect(keysAfter.get(BOT_ID)).toBeUndefined();
    // A remaining human is still a member at the new epoch.
    expect(keysAfter.get(OWNER_ID)).toBeTruthy();
  });
});
