/**
 * Public archive-root IDENTITY (root fingerprint) — the fix for silent, permanent
 * archive loss on public topics.
 *
 * The defect: a public topic has one random archive root and its rows are pinned
 * at `tak_version: 0`, so nothing distinguished the topic's real root from a root
 * some other device minted while it was still waiting to receive one. A second
 * device would mint an orphan, archive under it, win the 900s holder lease, and
 * broadcast that orphan to every member — overwriting each member's real root and
 * their server-side keychain backup along with it. Every previously archived row
 * became undecryptable for everyone, and passkey recovery "succeeded" while
 * opening nothing.
 *
 * The fix: `root_fingerprint = HKDF(root, "openstoa-archive-root-id/v1", 16)` is
 * published once per topic under compare-and-set. It answers both questions —
 * does a root exist, and is mine it — and gates minting, archiving, distributing,
 * bundle adoption, and the keychain backup.
 *
 * These run against the REAL MLS + TAK crypto over an in-memory DS, so the
 * fingerprints, HPKE bundles and AEAD archives are all genuine.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import {
  TakSessionStore,
  type TakTransport,
  type TakBundleRow,
  type ArchiveEntry,
  type ArchiveRootIdentity,
  type ArchiveRootClaim,
} from '@/lib/mls/takSession';
import * as tak from '@/lib/mls/takClient';
import { parseCommitFraming } from '@/lib/mls/framing';
import { readFileSync } from 'fs';
import path from 'path';

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
    if (framing.epoch !== g.epoch) return { ok: false };
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
  recipientUserId: string;
  recipientDeviceId: string;
  delivered: boolean;
}

/**
 * In-memory Delivery Service. The fingerprint half mirrors the server exactly:
 * opaque storage, no crypto, and COMPARE-AND-SET so the first writer wins
 * permanently. `offline` simulates an unreachable server for the fail-safe tests.
 */
class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  bundles = new Map<string, StoredBundle[]>();
  fingerprints = new Map<string, string>();
  offline = false;
  /** Topics this caller may no longer query — the real server answers 403 once
   *  the user has left, permanently and only for that topic. */
  unreachableTopics = new Set<string>();
  /** The archive LIST endpoint is down. Separate from `offline`, which is about
   *  the fingerprint endpoints — a caller can reach one and not the other. */
  archiveReadThrows = false;
  fingerprintReads = 0;
  fingerprintWrites = 0;
  private seq = 0;
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    if (this.archiveReadThrows) throw new Error('archive GET 503');
    // Insertion order is oldest-first and Array.prototype.sort is stable, so
    // rows sharing a millisecond keep their real order — which is what makes
    // "the oldest row" a meaningful oracle.
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async postBundle(t: string, recipientUserId: string, recipientDeviceId: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    if (list.some((b) => b.recipientDeviceId === recipientDeviceId && b.scope === scope && !b.delivered)) return;
    list.push({
      id: String(this.seq++).padStart(6, '0'),
      bundle,
      scope,
      createdAt: new Date().toISOString(),
      recipientUserId,
      recipientDeviceId,
      delivered: false,
    });
    this.bundles.set(t, list);
  }
  async getBundles(t: string, deviceId: string) {
    return (this.bundles.get(t) ?? []).filter((b) => b.recipientDeviceId === deviceId && !b.delivered);
  }
  async ackBundles(t: string, deviceId: string, ids: string[]) {
    for (const b of this.bundles.get(t) ?? []) {
      if (b.recipientDeviceId === deviceId && ids.includes(b.id)) b.delivered = true;
    }
  }
  async getRootFingerprint(t: string): Promise<ArchiveRootIdentity> {
    this.fingerprintReads++;
    if (this.offline) throw new Error('network down');
    if (this.unreachableTopics.has(t)) throw new Error('403: Not a member of this topic');
    return { fingerprint: this.fingerprints.get(t) ?? null, archiveCount: (this.archive.get(t) ?? []).length };
  }
  async setRootFingerprint(t: string, fingerprint: string): Promise<ArchiveRootClaim> {
    this.fingerprintWrites++;
    if (this.offline) throw new Error('network down');
    const cur = this.fingerprints.get(t);
    if (cur === undefined) {
      this.fingerprints.set(t, fingerprint);
      return { fingerprint, claimed: true };
    }
    return { fingerprint: cur, claimed: cur === fingerprint };
  }
}

function memKv(): SecureKVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

function makeClient(ds: MemoryDS, tt: MemoryTak, identity: string, onChange?: () => void) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const takStore = new TakSessionStore(mls, tt, kv, onChange);
  return { mls, tak: takStore, kv };
}

async function fanOutCommits(ds: MemoryDS, topic: string, members: { mls: MlsSessionStore }[]) {
  for (const c of await ds.getCommitsSince(topic, 0)) {
    for (const m of members) await m.mls.applyCommit(topic, c.commit);
  }
}

/** Bring a second member into the group and sync everyone's view of the tree. */
async function join(ds: MemoryDS, topic: string, host: { mls: MlsSessionStore }, joiner: { mls: MlsSessionStore }) {
  const seed = await host.mls.seal(topic, 'seed');
  await joiner.mls.open(topic, seed);
  await fanOutCommits(ds, topic, [host]);
}

// ---------------------------------------------------------------------------
// THE REGRESSION: an orphan root must never erase real history
// ---------------------------------------------------------------------------

describe('public archive root — orphan clobbering (the data-loss bug)', () => {
  it('a second device cannot mint a rival root, archive under it, or broadcast it over the real one', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'clobber-topic';

    // Alice is genesis: she mints the root, publishes its fingerprint, archives.
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'the-real-history', 'public')).archived).toBe(true);

    // Bob joins and opens the chat BEFORE any TAK bundle reaches him. This is the
    // exact moment the old code minted an orphan root.
    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);

    // 1. Bob does not mint. He archives nothing rather than writing a row no one
    //    can read, and says why.
    const bobArchive = await bob.tak.archiveOnSend(T, 'm-2', 'bob-msg', 'public');
    expect(bobArchive).toEqual({ archived: false, rootState: 'waiting' });
    expect(await tt.getArchive(T)).toHaveLength(1); // only alice's row

    // 2. Bob (who can easily win the 900s holder lease) broadcasts nothing.
    expect(await bob.tak.distributePublicRoot(T)).toBe(0);

    // 3. THE ASSERTION THAT FAILS AGAINST THE OLD CODE: after ingesting whatever
    //    Bob sent, Alice's root — and therefore her history — is intact. Before
    //    the fix, ingestBundles overwrote her root with Bob's orphan and this
    //    returned undefined.
    const history = await alice.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-1')?.plaintext).toBe('the-real-history');
    expect(await alice.tak.archiveRootState(T, 'public')).toBe('verified');

    // 4. Once Alice distributes, Bob adopts the real root and reads the history.
    expect(await alice.tak.distributePublicRoot(T)).toBe(2);
    const bobHistory = await bob.tak.backfill(T, 'public');
    expect(bobHistory.find((h) => h.messageId === 'm-1')?.plaintext).toBe('the-real-history');
    expect(await bob.tak.archiveRootState(T, 'public')).toBe('verified');
    expect((await bob.tak.archiveOnSend(T, 'm-3', 'bob-can-archive-now', 'public')).archived).toBe(true);
  });

  it('ingestBundles rejects a root whose fingerprint does not match the published one', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'reject-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'real', 'public');

    const mallory = makeClient(ds, tt, 'mallory');
    await join(ds, T, alice, mallory);

    // Mallory hand-crafts a bundle carrying a root of her choosing, addressed to
    // Alice's leaf (the HPKE wrap itself is valid — she IS a group member).
    const rogueRoot = tak.generatePublicRootKey();
    const aliceDev = await alice.tak.myDeviceId(T);
    await mallory.mls.sync(T);
    const leaves = await mallory.mls.readState(T, async (s) => tak.findRecipientLeaves(s, 'alice'));
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, { tier: 'public', rootKey: b64(rogueRoot) });
      await tt.postBundle(T, 'alice', tak.leafDeviceId(lf.hpkePublicKey), btoa(JSON.stringify(wrapped)), 'full');
    }
    expect((await tt.getBundles(T, aliceDev)).length).toBeGreaterThan(0);

    await alice.tak.ingestBundles(T);

    // The rogue root was not stored, and it was acked so it is not re-fetched
    // forever (a mismatch can never become valid: the fingerprint is write-once).
    expect(await alice.tak.archiveRootState(T, 'public')).toBe('verified');
    expect(await tt.getBundles(T, aliceDev)).toHaveLength(0);
    const history = await alice.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-1')?.plaintext).toBe('real');
  });

  it('REGRESSION: a device still waiting for the root cannot name it, so it cannot take the holder role', async () => {
    // The staging failure, reproduced: a topic with archived history whose root
    // identity was never published, joined by a brand-new device. That device
    // claimed the holder lease and locked itself out — the holder is who others
    // receive the root FROM, so nothing would ever hand it one.
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'waiting-device-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'history-that-must-survive', 'public');

    const newDevice = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, newDevice);

    // It has no root, and says so rather than offering one it does not have.
    expect(await newDevice.tak.archiveRootState(T, 'public')).toBe('waiting');
    expect(await newDevice.tak.publicRootFingerprint(T)).toBeNull();

    // The device that actually holds the root can name it — this is the only
    // device entitled to serve the role.
    const real = await alice.tak.publicRootFingerprint(T);
    expect(real).toBeTruthy();

    // And once the root arrives the newcomer can name the SAME one, so it may
    // then take over succession legitimately.
    await alice.tak.distributePublicRoot(T);
    await newDevice.tak.ingestBundles(T);
    expect(await newDevice.tak.publicRootFingerprint(T)).toBe(real);
  });
});

// ---------------------------------------------------------------------------
// Genesis + compare-and-set race
// ---------------------------------------------------------------------------

describe('public archive root — genesis race (compare-and-set)', () => {
  it('two devices racing the first root: one wins, the loser waits and never persists its own', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'race-topic';
    const alice = makeClient(ds, tt, 'alice');
    const bob = makeClient(ds, tt, 'bob');
    await alice.mls.seal(T, 'genesis');
    await join(ds, T, alice, bob);

    // Both resolve concurrently on a topic with no fingerprint and no rows.
    const [a, b] = await Promise.all([
      alice.tak.archiveRootState(T, 'public'),
      bob.tak.archiveRootState(T, 'public'),
    ]);

    // Exactly one fingerprint exists, and exactly one device is verified.
    expect(tt.fingerprints.size).toBe(1);
    const states = [a, b];
    expect(states.filter((s) => s === 'verified')).toHaveLength(1);
    expect(states.filter((s) => s === 'waiting')).toHaveLength(1);

    // The loser stored NOTHING: a just-minted root has sealed nothing, so keeping
    // it would only create a guaranteed orphan.
    const loser = a === 'waiting' ? alice : bob;
    expect(loser.kv.map.get(`tak.root.${T}`)).toBeUndefined();
  });

  it('a holder that distributes and archives concurrently still uses ONE root', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'concurrent-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');

    await Promise.all([
      alice.tak.archiveOnSend(T, 'm-race', 'raced', 'public'),
      alice.tak.distributePublicRoot(T),
    ]);
    expect(tt.fingerprints.size).toBe(1);
    expect(tt.fingerprintWrites).toBe(1); // one claim, not one per caller

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);
    await alice.tak.distributePublicRoot(T);
    const history = await bob.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-race')?.plaintext).toBe('raced');
  });

  it('a device that already holds the CORRECT root is a no-op — no re-store, no backup storm', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'noop-topic';
    let aliceChanges = 0;
    const alice = makeClient(ds, tt, 'alice', () => void aliceChanges++);
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');

    let bobChanges = 0;
    const bob = makeClient(ds, tt, 'bob', () => void bobChanges++);
    await join(ds, T, alice, bob);
    await alice.tak.distributePublicRoot(T);
    await bob.tak.ingestBundles(T);
    const afterFirstIngest = bobChanges;
    expect(afterFirstIngest).toBeGreaterThan(0); // adopting the root IS a change

    // Re-deliver the SAME root repeatedly (every mount + join event does this).
    for (let i = 0; i < 3; i++) {
      await alice.tak.distributePublicRoot(T);
      await bob.tak.ingestBundles(T);
    }
    expect(bobChanges).toBe(afterFirstIngest); // identical value → no write at all
    expect(aliceChanges).toBeGreaterThan(0);

    // And the holder never re-claims a fingerprint it already published.
    const writesBefore = tt.fingerprintWrites;
    await alice.tak.archiveOnSend(T, 'm-2', 'y', 'public');
    expect(tt.fingerprintWrites).toBe(writesBefore);
  });
});

// ---------------------------------------------------------------------------
// The retroactive case: rows exist, no fingerprint (every production topic today)
// ---------------------------------------------------------------------------

describe('public archive root — retroactive topics (rows, no fingerprint)', () => {
  /**
   * A topic as it exists in production RIGHT NOW: archive rows sealed under a
   * root the owner holds locally, and no fingerprint anywhere. Built by writing
   * the root + row directly rather than by calling the fixed code path, so the
   * pre-fix world is reproduced honestly (no client-side cache, no claim).
   */
  async function legacyTopic(ds: MemoryDS, tt: MemoryTak, T: string) {
    const owner = makeClient(ds, tt, 'owner');
    await owner.mls.seal(T, 'genesis');
    const realRoot = tak.generatePublicRootKey();
    owner.kv.map.set(`tak.root.${T}`, b64(realRoot));
    await tt.postArchive(T, 'm-old', 0, await tak.sealArchive(realRoot, 'm-old', 'pre-fingerprint-history'));
    expect(tt.fingerprints.get(T)).toBeUndefined();
    return owner;
  }

  it('a device with NO root must NOT mint one when archive rows already exist', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'legacy-nomint';
    const owner = await legacyTopic(ds, tt, T);

    const newcomer = makeClient(ds, tt, 'newcomer');
    await join(ds, T, owner, newcomer);

    // Rows are permanent proof a root exists — unlike tak_bundles, which are
    // deleted on delivery. Minting here is what orphaned production topics.
    expect(await newcomer.tak.archiveRootState(T, 'public')).toBe('waiting');
    expect((await newcomer.tak.archiveOnSend(T, 'm-new', 'nope', 'public')).archived).toBe(false);
    expect(tt.fingerprints.get(T)).toBeUndefined(); // it did not claim, either
  });

  it('the device holding the REAL root claims the fingerprint (it opens the oldest row)', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'legacy-claim';
    const owner = await legacyTopic(ds, tt, T);

    expect(await owner.tak.archiveRootState(T, 'public')).toBe('verified');
    expect(tt.fingerprints.get(T)).toBeTruthy();
    expect((await owner.tak.archiveOnSend(T, 'm-2', 'still-works', 'public')).archived).toBe(true);
  });

  it('a device holding an orphan root cannot claim it — it does not open the oldest row', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'legacy-orphan';
    const owner = await legacyTopic(ds, tt, T);

    // Simulate the damage already done in production: this device minted its own
    // root before the fix and archived under it.
    const orphaned = makeClient(ds, tt, 'orphaned');
    await join(ds, T, owner, orphaned);
    const orphanRoot = tak.generatePublicRootKey();
    orphaned.kv.map.set(`tak.root.${T}`, b64(orphanRoot));
    await tt.postArchive(T, 'm-orphan', 0, await tak.sealArchive(orphanRoot, 'm-orphan', 'only-i-can-read-this'));

    expect(await orphaned.tak.archiveRootState(T, 'public')).toBe('orphan');
    expect((await orphaned.tak.archiveOnSend(T, 'm-more', 'nope', 'public')).archived).toBe(false);
    expect(await orphaned.tak.distributePublicRoot(T)).toBe(0);
    expect(tt.fingerprints.get(T)).toBeUndefined(); // nothing published by an orphan

    // READ-ONLY, not deleted: rows it sealed itself stay readable to it.
    const own = await orphaned.tak.backfill(T, 'public');
    expect(own.find((h) => h.messageId === 'm-orphan')?.plaintext).toBe('only-i-can-read-this');
  });

  it('repairs an orphaned device: it adopts a root that opens the oldest row while its own does not', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'legacy-repair';
    const owner = await legacyTopic(ds, tt, T);

    const orphaned = makeClient(ds, tt, 'orphaned');
    await join(ds, T, owner, orphaned);
    const orphanRoot = tak.generatePublicRootKey();
    orphaned.kv.map.set(`tak.root.${T}`, b64(orphanRoot));
    await tt.postArchive(T, 'm-orphan', 0, await tak.sealArchive(orphanRoot, 'm-orphan', 'my-orphan-row'));

    // The real holder distributes while the topic still has no fingerprint.
    await owner.mls.sync(T);
    const leaves = await owner.mls.readState(T, async (s) => tak.findRecipientLeaves(s, 'orphaned'));
    const realRoot = unb64(owner.kv.map.get(`tak.root.${T}`)!);
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, { tier: 'public', rootKey: b64(realRoot) });
      await tt.postBundle(T, 'orphaned', tak.leafDeviceId(lf.hpkePublicKey), btoa(JSON.stringify(wrapped)), 'full');
    }

    const history = await orphaned.tak.backfill(T, 'public');
    // It adopted the real root (reads the pre-fix history) AND kept the orphan
    // read-only, so its own row survives the repair.
    expect(history.find((h) => h.messageId === 'm-old')?.plaintext).toBe('pre-fingerprint-history');
    expect(history.find((h) => h.messageId === 'm-orphan')?.plaintext).toBe('my-orphan-row');
  });

  it('does NOT adopt an incoming root that cannot open the oldest row either', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'legacy-no-adopt';
    const owner = await legacyTopic(ds, tt, T);

    const victim = makeClient(ds, tt, 'victim');
    await join(ds, T, owner, victim);
    const victimRoot = unb64(owner.kv.map.get(`tak.root.${T}`)!); // victim holds the REAL root
    victim.kv.map.set(`tak.root.${T}`, b64(victimRoot));

    // A third device pushes a root that opens nothing.
    const junk = tak.generatePublicRootKey();
    await owner.mls.sync(T);
    const leaves = await owner.mls.readState(T, async (s) => tak.findRecipientLeaves(s, 'victim'));
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, { tier: 'public', rootKey: b64(junk) });
      await tt.postBundle(T, 'victim', tak.leafDeviceId(lf.hpkePublicKey), btoa(JSON.stringify(wrapped)), 'full');
    }

    await victim.tak.ingestBundles(T);
    expect(victim.kv.map.get(`tak.root.${T}`)).toBe(b64(victimRoot)); // untouched
  });
});

// ---------------------------------------------------------------------------
// Fail-safe: never mint or archive on an unverifiable check
// ---------------------------------------------------------------------------

describe('public archive root — server unreachable (fail safe)', () => {
  it('does not mint a root, archive, or distribute while the check cannot be completed', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'offline-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');

    tt.offline = true;
    expect(await alice.tak.archiveRootState(T, 'public')).toBe('unverified');
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public')).archived).toBe(false);
    expect(await alice.tak.distributePublicRoot(T)).toBe(0);
    expect(await alice.tak.sealForPush(T, 'x', 'public')).toBeNull();
    expect(await alice.tak.takForPush(T, 'public')).toBeNull();
    expect(alice.kv.map.get(`tak.root.${T}`)).toBeUndefined(); // nothing minted
    expect(tt.fingerprints.size).toBe(0);
  });

  it('recovers on its own once the server is reachable again', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'recover-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');

    tt.offline = true;
    expect(await alice.tak.archiveRootState(T, 'public')).toBe('unverified');
    tt.offline = false;
    // An unsettled state is re-checked (only 'verified' is cached for the
    // session), so the very next archive succeeds without any manual reset.
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'back-online', 'public')).archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live chat is never blocked; per-epoch tiers are untouched
// ---------------------------------------------------------------------------

describe('public archive root — scope of the gate', () => {
  it('a device waiting for the root still sends and receives live MLS messages', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'live-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'history', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);
    expect(await bob.tak.archiveRootState(T, 'public')).toBe('waiting');

    // MLS application messages are independent of the archive root: Bob sends,
    // Alice reads, and the archive append merely reports that it was skipped.
    const msg = await bob.mls.seal(T, 'hello from a waiting device');
    await fanOutCommits(ds, T, [alice]);
    expect(await alice.mls.open(T, msg)).toBe('hello from a waiting device');
    await expect(bob.tak.archiveOnSend(T, 'm-2', 'hello', 'public')).resolves.toEqual({
      archived: false,
      rootState: 'waiting',
    });
  });

  it('private/secret topics are per-epoch: no root state, no fingerprint traffic', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'private-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');

    const before = tt.fingerprintReads + tt.fingerprintWrites;
    expect(await alice.tak.archiveRootState(T, 'private')).toBeNull();
    const r = await alice.tak.archiveOnSend(T, 'm-1', 'scoped', 'private');
    expect(r).toEqual({ archived: true, rootState: null });
    expect(await alice.tak.archiveRootState(T, 'secret')).toBeNull();
    expect(tt.fingerprintReads + tt.fingerprintWrites).toBe(before);

    // Even with the server unreachable, the per-epoch path is unaffected.
    tt.offline = true;
    expect((await alice.tak.archiveOnSend(T, 'm-2', 'still-scoped', 'private')).archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keychain backup must never carry an orphan root (§6.4.1)
// ---------------------------------------------------------------------------

describe('public archive root — keychain backup integrity', () => {
  it('omits an orphan root from the exported keychain but keeps verified ones', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const GOOD = 'good-topic';
    const BAD = 'bad-topic';
    const alice = makeClient(ds, tt, 'alice');

    await alice.mls.seal(GOOD, 'g');
    await alice.tak.archiveOnSend(GOOD, 'm-g', 'good', 'public');
    await alice.mls.seal(BAD, 'b');
    await alice.tak.archiveOnSend(BAD, 'm-b', 'bad', 'public');
    await alice.tak.archiveOnSend(BAD, 'm-b2', 'bad2', 'private'); // an epoch key too

    // Another device wins BAD's identity, retroactively making alice's an orphan.
    tt.fingerprints.set(BAD, await tak.deriveRootFingerprint(tak.generatePublicRootKey()));

    const keychain = await alice.tak.exportKeychain();
    expect(Object.keys(keychain)).toContain(`tak.root.${GOOD}`);
    expect(Object.keys(keychain)).not.toContain(`tak.root.${BAD}`);
    // Per-epoch keys are never root-based, so they are unaffected by the gate.
    expect(Object.keys(keychain).some((k) => k.startsWith(`tak.epoch.${BAD}.`))).toBe(true);
  });

  it('REGRESSION: an uncheckable root is skipped, and every OTHER key still exports', async () => {
    // This used to throw and abort the whole export, on the reasoning that a
    // partial keychain would overwrite a good backup. Uploads merge now, so the
    // abort protected nothing and cost everything: on a real device a single
    // topic the user had left answered 403 forever to the fingerprint check, and
    // that one permanently-unanswerable key stopped all seven of that device's
    // roots from ever reaching the backup.
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const REACHABLE = 'export-reachable';
    const GONE = 'export-left-this-topic';
    const alice = makeClient(ds, tt, 'alice');
    for (const t of [REACHABLE, GONE]) {
      await alice.mls.seal(t, 'g');
      await alice.tak.archiveOnSend(t, 'm-1', 'x', 'public');
    }
    // Both roots verified while we could still ask.
    expect(await alice.tak.archiveRootState(REACHABLE, 'public')).toBe('verified');
    expect(await alice.tak.archiveRootState(GONE, 'public')).toBe('verified');

    tt.unreachableTopics = new Set([GONE]);
    const keychain = await alice.tak.exportKeychain();

    expect(Object.keys(keychain)).toContain(`tak.root.${REACHABLE}`);
    expect(Object.keys(keychain)).not.toContain(`tak.root.${GONE}`);
  });

  it('a fully unreachable server exports nothing rather than vouching for roots it cannot check', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'export-offline';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'g');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');

    tt.offline = true;
    // No throw — but no unverified root either. The upload merges, so exporting
    // nothing is a safe no-op, while exporting an unchecked root is not.
    expect(await alice.tak.exportKeychain()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Root DELIVERY to devices that join after the hand-out
// ---------------------------------------------------------------------------

/**
 * Distribution used to run once, when a device entered the chat and won the
 * holder lease. A device that joined the group a minute later got nothing: the
 * distributor had already served the only leaf that existed, and nothing re-ran.
 * Reproduced on staging with a topic created minutes earlier and every other fix
 * deployed — the newcomer sat on '[unable to decrypt]' until an unrelated device
 * happened to reopen the room.
 */
describe('public root re-distribution on membership change', () => {
  it('REGRESSION: a device that joins AFTER the hand-out still gets the root', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'late-joiner';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'sent-before-bob-existed', 'public');

    // Alice hands out while she is the only leaf — the state that stranded the
    // newcomer, because this was the ONLY time distribution ran.
    expect(await alice.tak.distributePublicRootWhenGroupChanged(T)).toBe(1);

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);
    expect(await bob.tak.archiveRootState(T, 'public')).toBe('waiting');

    // The group changed, so this round reaches Bob's leaf too.
    expect(await alice.tak.distributePublicRootWhenGroupChanged(T)).toBeGreaterThan(0);
    await bob.tak.ingestBundles(T);

    expect(await bob.tak.archiveRootState(T, 'public')).toBe('verified');
    const history = await bob.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-1')?.plaintext).toBe('sent-before-bob-existed');
  });

  it('an unchanged group sends nothing, so a repeating caller cannot flood bundles', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'quiet-group';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'g');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');

    expect(await alice.tak.distributePublicRootWhenGroupChanged(T)).toBe(1);
    expect(await alice.tak.distributePublicRootWhenGroupChanged(T)).toBe(0);
    expect(await alice.tak.distributePublicRootWhenGroupChanged(T)).toBe(0);
  });

  it('a device with no verified root distributes nothing and does not retry forever', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'no-root-here';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'g');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);

    expect(await bob.tak.distributePublicRootWhenGroupChanged(T)).toBe(0);
    // Second call is a no-op for the same epoch: spinning on every tick would
    // cost a sync per event for a device that can never serve this epoch.
    expect(await bob.tak.distributePublicRootWhenGroupChanged(T)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Archive GAPS — messages that were never archived at all
// ---------------------------------------------------------------------------

/**
 * `archiveOnSend` runs once, at send time, and writes nothing while the root is
 * unverified — offline, a server hiccup, or a device that has not received the
 * topic root yet. Nothing retried, so the message stayed out of the archive
 * permanently and every later device was simply missing it, silently.
 */
describe('archive gap back-fill', () => {
  async function topicWithGap() {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'gap-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    // m-1 archives normally and establishes the topic root. m-2 is simply never
    // archived — the END STATE is what matters here, and it is reached by every
    // route that skips the one send-time attempt (offline, 5xx, a root that was
    // not verified yet). Simulating one particular route would test the route,
    // not the gap.
    await alice.tak.archiveOnSend(T, 'm-1', 'first', 'public');
    expect((await tt.getArchive(T)).map((r) => r.messageId)).toEqual(['m-1']);
    return { tt, T, alice };
  }

  it('REGRESSION: a message that missed its one chance is archived later', async () => {
    const { tt, T, alice } = await topicWithGap();

    const added = await alice.tak.backfillMissingArchive(T, 'public', [
      { messageId: 'm-1', plaintext: 'first' },
      { messageId: 'm-2', plaintext: 'lost-to-the-gap' },
    ]);

    expect(added).toBe(1); // only the missing one
    expect((await tt.getArchive(T)).map((r) => r.messageId).sort()).toEqual(['m-1', 'm-2']);
  });

  it('INTEGRITY: the back-filled row opens for a device that only has the root', async () => {
    const { tt, T, alice } = await topicWithGap();
    await alice.tak.backfillMissingArchive(T, 'public', [{ messageId: 'm-2', plaintext: 'lost-to-the-gap' }]);

    const history = await alice.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-2')?.plaintext).toBe('lost-to-the-gap');
  });

  it('IDEMPOTENT: a second pass adds nothing, and concurrent members converge', async () => {
    const { tt, T, alice } = await topicWithGap();
    const readable = [{ messageId: 'm-2', plaintext: 'lost-to-the-gap' }];

    expect(await alice.tak.backfillMissingArchive(T, 'public', readable)).toBe(1);
    expect(await alice.tak.backfillMissingArchive(T, 'public', readable)).toBe(0);
    expect((await tt.getArchive(T)).filter((r) => r.messageId === 'm-2')).toHaveLength(1);
  });

  it('BOUNDARY: an empty list is a no-op that never touches the server', async () => {
    const { tt, T, alice } = await topicWithGap();
    const before = tt.fingerprintReads;
    expect(await alice.tak.backfillMissingArchive(T, 'public', [])).toBe(0);
    expect(tt.fingerprintReads).toBe(before);
  });

  it('HOSTILE: an unverified root fills nothing — it would write rows nobody can open', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'gap-unverified';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'g');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');

    // A second device that has not received the root: state 'waiting', no key.
    const newcomer = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, newcomer);
    expect(await newcomer.tak.archiveRootState(T, 'public')).toBe('waiting');

    expect(await newcomer.tak.backfillMissingArchive(T, 'public', [{ messageId: 'm-9', plaintext: 'nope' }])).toBe(0);
    expect((await tt.getArchive(T)).map((r) => r.messageId)).toEqual(['m-1']);
  });

  it('EXTERNAL FAILURE: an unreadable archive fills nothing rather than re-uploading everything', async () => {
    const { tt, T, alice } = await topicWithGap();
    // Resolve the root while the server still answers, then lose it.
    expect(await alice.tak.archiveRootState(T, 'public')).toBe('verified');
    tt.archiveReadThrows = true;

    expect(await alice.tak.backfillMissingArchive(T, 'public', [{ messageId: 'm-2', plaintext: 'x' }])).toBe(0);
    tt.archiveReadThrows = false;
    expect((await tt.getArchive(T)).map((r) => r.messageId)).toEqual(['m-1']);
  });

  it('EMPTY plaintext is skipped, so a placeholder never claims the row', async () => {
    const { tt, T, alice } = await topicWithGap();
    expect(await alice.tak.backfillMissingArchive(T, 'public', [{ messageId: 'm-2', plaintext: '' }])).toBe(0);
    expect((await tt.getArchive(T)).map((r) => r.messageId)).toEqual(['m-1']);
  });
});

// ---------------------------------------------------------------------------
// The fingerprint primitive itself
// ---------------------------------------------------------------------------

describe('deriveRootFingerprint', () => {
  it('is deterministic, 16 bytes, and distinct per root', async () => {
    const r1 = tak.generatePublicRootKey();
    const r2 = tak.generatePublicRootKey();
    const f1 = await tak.deriveRootFingerprint(r1);
    expect(await tak.deriveRootFingerprint(r1)).toBe(f1);
    expect(await tak.deriveRootFingerprint(r2)).not.toBe(f1);
    expect(unb64(f1)).toHaveLength(16);
    expect(f1).toHaveLength(tak.ROOT_FINGERPRINT_B64_LEN);
    expect(f1).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('is one-way and domain-separated — it is not the root and not any archive key', async () => {
    const root = tak.generatePublicRootKey();
    const fp = await tak.deriveRootFingerprint(root);
    // Publishing the tag must not publish key material, and the tag must not
    // double as a key anywhere else in the system.
    expect(fp).not.toBe(b64(root));
    expect(b64(root)).not.toContain(fp);
    // A one-bit change in the root gives a completely different tag.
    const flipped = new Uint8Array(root);
    flipped[0] ^= 1;
    expect(await tak.deriveRootFingerprint(flipped)).not.toBe(fp);
    // Same root, different context → different value (the archive AEAD key).
    const sealed = await tak.sealArchive(root, 'msg-1', 'p');
    expect(sealed).not.toContain(fp);
  });

  it('the mobile mirror is byte-identical, so both clients compute the same tag', () => {
    // The KDF label and length are a wire contract between web and mobile. A
    // divergence here would silently split the two into different fingerprints
    // for the same root, which reads exactly like the bug being fixed.
    const root = path.resolve(__dirname, '../..');
    for (const f of ['takClient.ts', 'takSession.ts']) {
      const web = readFileSync(path.join(root, 'src/lib/mls', f), 'utf-8');
      const mobile = readFileSync(path.join(root, 'packages/mobile/src/crypto', f), 'utf-8');
      expect(mobile, `${f} drifted between web and mobile`).toBe(web);
    }
    const web = readFileSync(path.join(root, 'src/lib/mls/takClient.ts'), 'utf-8');
    expect(web).toContain("'openstoa-archive-root-id/v1'");
    expect(web).toContain('ROOT_FINGERPRINT_LEN = 16');
  });
});
