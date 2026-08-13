/**
 * Phase 5 AI-member client mechanics end-to-end against an in-memory Delivery
 * Service + the REAL MLS + TAK crypto (no server/browser/device). Proves:
 *   - groupClient.removeMember: a Remove Commit drops one leaf, advances the
 *     epoch, and the removed device is gone from the validated tree while a
 *     remaining member keeps reading (D11 future-epoch PCS).
 *   - aiMember orchestration (§7 D9/D11, §9.3 ZAEP): a bot publishes its OWN
 *     reusable last-resort KeyPackage, self-joins via External Commit with its
 *     OWN leaf key (zero human key sharing), reads ONLY in-scope granted epochs
 *     (out-of-scope unreadable), is removed on revoke (grant DELETE + Remove),
 *     and its last-resort KeyPackage stays reusable (re-addable).
 */
import { describe, it, expect } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import {
  botPublishKeyPackage,
  botJoin,
  grantAiHistory,
  removeAiMember,
  type AiMemberDirectory,
} from '@/lib/mls/aiMember';
import { parseCommitFraming } from '@/lib/mls/framing';

const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

class MemoryDS implements MlsTransport {
  groups = new Map<string, { groupInfo: string; epoch: number; groupId: string }>();
  commits = new Map<string, CommitLogEntry[]>();
  async getGroupInfo(t: string) {
    return this.groups.get(t)?.groupInfo ?? null;
  }
  async postGroupInfo(t: string, gi: string, gid: string) {
    if (this.groups.has(t)) return false;
    this.groups.set(t, { groupInfo: gi, epoch: 0, groupId: gid });
    this.commits.set(t, []);
    return true;
  }
  async postCommit(t: string, commitB64: string, giB64: string) {
    const g = this.groups.get(t);
    if (!g) return { ok: false };
    const framing = parseCommitFraming(unb64(commitB64));
    if (framing.epoch !== g.epoch) return { ok: false }; // epoch-CAS
    g.epoch = framing.epoch + 1;
    g.groupInfo = giB64;
    this.commits.get(t)!.push({ epoch: g.epoch, commit: commitB64, welcome: null });
    return { ok: true, epoch: g.epoch };
  }
  async getCommitsSince(t: string, since: number) {
    return (this.commits.get(t) ?? []).filter((c) => c.epoch > since);
  }
}

interface StoredBundle extends TakBundleRow {
  recipientDeviceId: string;
  delivered: boolean;
}
class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  bundles = new Map<string, StoredBundle[]>();
  private seq = 0;
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async postBundle(t: string, _ru: string, recipientDeviceId: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    if (list.some((b) => b.recipientDeviceId === recipientDeviceId && b.scope === scope && !b.delivered)) return;
    list.push({ id: String(this.seq++).padStart(6, '0'), bundle, scope, createdAt: new Date().toISOString(), recipientDeviceId, delivered: false });
    this.bundles.set(t, list);
  }
  async getBundles(t: string, deviceId: string) {
    return (this.bundles.get(t) ?? []).filter((b) => b.recipientDeviceId === deviceId && !b.delivered);
  }
  async ackBundles(t: string, deviceId: string, ids: string[]) {
    for (const b of this.bundles.get(t) ?? []) if (b.recipientDeviceId === deviceId && ids.includes(b.id)) b.delivered = true;
  }
  fingerprints = new Map<string, string>();
  async getServerRoot(): Promise<Uint8Array | null> {
    return null;
  }
  async putServerRoot(): Promise<boolean> {
    return true;
  }
  async getRootFingerprint(t: string) {
    return { fingerprint: this.fingerprints.get(t) ?? null, archiveCount: (this.archive.get(t) ?? []).length };
  }
  async setRootFingerprint(t: string, fingerprint: string) {
    const cur = this.fingerprints.get(t);
    if (cur === undefined) {
      this.fingerprints.set(t, fingerprint);
      return { fingerprint, claimed: true };
    }
    return { fingerprint: cur, claimed: cur === fingerprint };
  }
}

/** In-memory AI directory: atomic KeyPackage consume (last-resort reusable). */
class MemoryDirectory implements AiMemberDirectory {
  keyPackages = new Map<string, { id: string; deviceId: string; keyPackage: string; isAI: boolean; isLastResort: boolean; consumed: boolean }[]>();
  private seq = 0;
  async publishKeyPackage(topicId: string, body: { keyPackage: string; deviceId: string; isAI: boolean; isLastResort: boolean }) {
    const list = this.keyPackages.get(topicId) ?? [];
    const id = `kp-${this.seq++}`;
    list.push({ id, ...body, consumed: false });
    this.keyPackages.set(topicId, list);
    return { id };
  }
  /** SI-3 atomic consume: claim one unconsumed KP; last-resort is returned without consuming. */
  consumeKeyPackage(topicId: string, deviceId: string) {
    const list = this.keyPackages.get(topicId) ?? [];
    const kp = list.find((k) => k.deviceId === deviceId && (!k.consumed || k.isLastResort));
    if (!kp) return null;
    if (!kp.isLastResort) kp.consumed = true;
    return kp;
  }
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeClient(ds: MemoryDS, tt: MemoryTak, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  return { mls, tak, identity };
}

async function fanOutCommits(ds: MemoryDS, topic: string, members: { mls: MlsSessionStore }[]) {
  for (const c of await ds.getCommitsSince(topic, 0)) {
    for (const m of members) await m.mls.applyCommit(topic, c.commit);
  }
}

/** Read every basic-credential leaf's hpke public key (base64) from a live state. */
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

describe('groupClient.removeMember — Remove Commit drops a leaf and advances the epoch', () => {
  it('a removed device leaves the tree; a remaining member keeps reading', async () => {
    const alice = await gc.createDevice('alice');
    const bob = await gc.createDevice('bob');
    const carol = await gc.createDevice('carol');

    const g = await gc.createTopicGroup('t', alice);
    let a = g.state;
    const j1 = await gc.joinTopicGroup(bob, g.groupInfoB64);
    let b = j1.state;
    a = await gc.processCommit(a, j1.commitB64);
    const j2 = await gc.joinTopicGroup(carol, j1.groupInfoB64);
    let c = j2.state;
    a = await gc.processCommit(a, j2.commitB64);
    b = await gc.processCommit(b, j2.commitB64);
    expect(gc.currentEpoch(a)).toBe(2);

    // Alice removes Bob's leaf.
    const bobLeaf = gc.findLeafIndexByIdentity(a, 'bob');
    expect(bobLeaf).not.toBeNull();
    const rm = await gc.removeMember(a, bobLeaf!);
    a = rm.state;
    c = await gc.processCommit(c, rm.commitB64);
    expect(gc.currentEpoch(a)).toBe(3);
    expect(gc.currentEpoch(c)).toBe(3);

    // Bob is gone from both surviving members' validated trees.
    expect(gc.findLeafIndexByIdentity(a, 'bob')).toBeNull();
    expect(gc.findLeafIndexByIdentity(c, 'bob')).toBeNull();

    // Alice ↔ Carol still exchange messages at the new epoch.
    const s = await gc.sealMessage(a, 'post-remove');
    a = s.state;
    const o = await gc.openMessage(c, s.sealed);
    expect(o).toMatchObject({ kind: 'message', plaintext: 'post-remove' });

    // Bob's stale state can no longer open (removed → forward secrecy).
    await expect(gc.openMessage(b, s.sealed)).rejects.toThrow();
  });
});

describe('aiMember — bot self-join, scoped history, revoke (D9/D11, ZAEP)', () => {
  it('bot joins with its OWN leaf, reads only in-scope epochs, and is removed on revoke', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const dir = new MemoryDirectory();
    const T = 'ai-topic';

    // Owner (human) genesis at epoch 0 and archives a PRIVATE epoch-0 message.
    const owner = makeClient(ds, tt, 'owner-human');
    await owner.mls.seal(T, 'genesis');
    await owner.tak.archiveOnSend(T, 'm-e0', 'epoch0-secret', 'private');

    // A second human joins → epoch 1; owner archives an epoch-1 message.
    const carol = makeClient(ds, tt, 'carol-human');
    const seed = await owner.mls.seal(T, 'seed');
    await carol.mls.open(T, seed);
    await fanOutCommits(ds, T, [owner]);
    await owner.tak.archiveOnSend(T, 'm-e1', 'epoch1-secret', 'private');

    // ── Bot: publish its OWN reusable last-resort KeyPackage (isAI) ──────────
    const BOT_ID = 'ai-bot-device-1';
    const pub = await botPublishKeyPackage(dir, T, BOT_ID);
    expect(pub.id).toBeTruthy();
    const stored = dir.keyPackages.get(T)!.find((k) => k.deviceId === BOT_ID)!;
    expect(stored.isAI).toBe(true);
    expect(stored.isLastResort).toBe(true);

    // ── Bot self-joins via External Commit (its OWN leaf key), → epoch 2 ─────
    const bot = makeClient(ds, tt, BOT_ID);
    const botEpoch = await botJoin(bot.mls, T);
    expect(botEpoch).toBe(2);
    await fanOutCommits(ds, T, [owner, carol]);

    // D9 — zero human key sharing: the bot's leaf key differs from every human's.
    const keys = await leafKeys(owner.mls, T);
    expect(keys.get(BOT_ID)).toBeTruthy();
    expect(keys.get(BOT_ID)).not.toBe(keys.get('owner-human'));
    expect(keys.get(BOT_ID)).not.toBe(keys.get('carol-human'));

    // AI capability is now configured in the owner's PROFILE
    // (PUT /api/profile/ai-permissions), not as a per-topic grant here. This
    // test covers only the MLS/TAK cryptographic membership mechanics; the
    // capability gate is exercised in ai-permissions.test.ts.

    // Before any TAK grant the bot reads NO pre-join history (forward secrecy).
    expect((await bot.tak.backfill(T, 'private')).length).toBe(0);

    // Grant ONLY epoch 1's TAK (history scope since_epoch:1) to the bot's leaf.
    const delivered = await grantAiHistory(owner.tak, T, BOT_ID, [1]);
    expect(delivered).toBeGreaterThanOrEqual(1);

    // In-scope-only: the bot reads the epoch-1 archive but NOT the epoch-0 one.
    const history = await bot.tak.backfill(T, 'private');
    expect(history.find((h) => h.messageId === 'm-e1')?.plaintext).toBe('epoch1-secret');
    expect(history.find((h) => h.messageId === 'm-e0')).toBeUndefined();

    // Last-resort KeyPackage stays reusable → bot is re-addable after a Remove.
    const c1 = dir.consumeKeyPackage(T, BOT_ID);
    const c2 = dir.consumeKeyPackage(T, BOT_ID);
    expect(c1?.id).toBe(pub.id);
    expect(c2?.id).toBe(pub.id); // reusable: same package returned twice

    // ── Remove (§9.4): MLS Remove Commit excludes the bot from future epochs ──
    const epochAfter = await removeAiMember(owner.mls, T, BOT_ID);
    expect(epochAfter).toBe(3);
    // The bot's leaf is removed from the owner's validated tree at the new epoch.
    const keysAfter = await leafKeys(owner.mls, T);
    expect(keysAfter.get(BOT_ID)).toBeUndefined();
    await owner.mls.readState(T, async (s) => expect(gc.findLeafIndexByIdentity(s, BOT_ID)).toBeNull());
  });
});
