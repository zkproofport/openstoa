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
  /**
   * The server-held archive root, modelled with the guarantees the real route
   * actually gives — a double that just answers `null`/`true` would let every
   * device mint its own root and would prove nothing.
   *
   *  - one row per topic, WRITE-ONCE: a different key is refused
   *  - the same key again succeeds, so a client retry is safe
   *  - a FIRST deposit is refused once the archive has rows, because a root
   *    arriving after them cannot be the one they were sealed under
   */
  serverRoots = new Map<string, string>();
  serverRootReads = 0;
  serverRootWrites = 0;
  async getServerRoot(t: string): Promise<Uint8Array | null> {
    this.serverRootReads++;
    if (this.offline) throw new Error('network down');
    if (this.unreachableTopics.has(t)) throw new Error('403: Not a member of this topic');
    const v = this.serverRoots.get(t);
    return v ? unb64(v) : null;
  }
  async putServerRoot(t: string, root: Uint8Array): Promise<boolean> {
    this.serverRootWrites++;
    if (this.offline) throw new Error('network down');
    if (this.unreachableTopics.has(t)) throw new Error('403: Not a member of this topic');
    const incoming = b64(root);
    const held = this.serverRoots.get(t);
    if (held) return held === incoming;
    if ((this.archive.get(t) ?? []).length > 0) return false;
    this.serverRoots.set(t, incoming);
    return true;
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

// ---------------------------------------------------------------------------
// THE REGRESSION: an orphan root must never erase real history
// ---------------------------------------------------------------------------

describe('public archive root — one root per topic, decided by the server', () => {
  it('REGRESSION: a second device adopts the topic root instead of minting a rival', async () => {
    /*
     * The data-loss bug in its original form: a device that had not yet been
     * handed the root would mint its own, archive under it, and hand that
     * orphan to everyone — making every previously archived row undecryptable
     * for every member at once.
     *
     * The server now answers "here is this topic's root", so a device that
     * lacks one asks rather than invents.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'one-root-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'history-that-must-survive', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);

    expect(await bob.tak.archiveRootState(T, 'public')).toBe('verified');
    const recovered = await bob.tak.backfill(T, 'public');
    expect(recovered).toEqual([{ messageId: 'm-1', plaintext: 'history-that-must-survive' }]);
  });

  it('CONTRACT: the deposit is write-once — a rival key cannot replace the real one', async () => {
    const tt = new MemoryTak();
    const T = 'write-once-topic';
    const real = tak.generatePublicRootKey();
    const rival = tak.generatePublicRootKey();

    expect(await tt.putServerRoot(T, real)).toBe(true);
    expect(await tt.putServerRoot(T, rival)).toBe(false);
    // Depositing the SAME key again succeeds, which is what makes a client
    // retry safe rather than a coin flip.
    expect(await tt.putServerRoot(T, real)).toBe(true);
    expect(b64((await tt.getServerRoot(T))!)).toBe(b64(real));
  });
});

describe('public archive root — genesis race', () => {
  it('two devices racing the first root end up with the SAME one', async () => {
    /*
     * Both mint, both deposit, one wins. The loser must adopt the winner's key
     * rather than keep its own: the key it minted sealed nothing, so dropping
     * it costs nothing, and keeping it would guarantee rows nobody else reads.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'race-topic';
    const alice = makeClient(ds, tt, 'alice');
    const bob = makeClient(ds, tt, 'bob');
    await alice.mls.seal(T, 'genesis');
    await join(ds, T, alice, bob);

    const [a, b] = await Promise.all([
      alice.tak.archiveRootState(T, 'public'),
      bob.tak.archiveRootState(T, 'public'),
    ]);
    expect([a, b]).toEqual(['verified', 'verified']);

    // The proof that matters is not the state string: it is that each can read
    // what the other sealed.
    await alice.tak.archiveOnSend(T, 'from-alice', 'alice wrote this', 'public');
    await bob.tak.archiveOnSend(T, 'from-bob', 'bob wrote this', 'public');
    const asBob = await bob.tak.backfill(T, 'public');
    expect(asBob.map((r) => r.plaintext).sort()).toEqual(['alice wrote this', 'bob wrote this']);
  });

  it('exactly one key is ever stored for a topic', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'single-key-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveRootState(T, 'public');
    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'public');
    await alice.tak.archiveRootState(T, 'public');
    expect(tt.serverRoots.size).toBe(1);
  });
});

describe('public archive root — a topic that already has an archive', () => {
  it('REGRESSION: no root is minted over existing rows', async () => {
    /*
     * Archive rows are permanent proof that a root existed. Minting a fresh one
     * over them would leave every row sealed under a key nobody has — the same
     * silent loss the fingerprint check used to prevent, now enforced by the
     * server, which can count rows without reading one.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'retroactive-topic';
    // Rows exist, but nothing was ever deposited — the state a topic archived
    // before this mechanism existed would be in.
    tt.archive.set(T, [
      { messageId: 'old-1', takVersion: 0, ciphertext: 'unreadable', createdAt: new Date().toISOString() },
    ]);

    const device = makeClient(ds, tt, 'newcomer');
    await device.mls.seal(T, 'genesis');
    const state = await device.tak.archiveRootState(T, 'public');

    expect(state).not.toBe('verified');
    expect(tt.serverRoots.has(T)).toBe(false);
  });

  it('and nothing is archived under a root that was never established', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'retroactive-no-write';
    tt.archive.set(T, [
      { messageId: 'old-1', takVersion: 0, ciphertext: 'unreadable', createdAt: new Date().toISOString() },
    ]);
    const device = makeClient(ds, tt, 'newcomer');
    await device.mls.seal(T, 'genesis');
    await device.tak.archiveOnSend(T, 'new-1', 'must not be written', 'public');
    // Still just the pre-existing row: writing one nobody can open would be
    // worse than writing none.
    expect((tt.archive.get(T) ?? []).map((r) => r.messageId)).toEqual(['old-1']);
  });
});


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
  it('a device that cannot reach the archive still sends and receives live MLS messages', async () => {
    /*
     * Nobody WAITS for a public root any more — the server answers — so the
     * stall this once described is now "the archive is unreachable". The
     * guarantee is the one that mattered either way: live chat does not depend
     * on the archive, so a device that cannot read history can still talk.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'live-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'history', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);
    tt.offline = true;
    expect(await bob.tak.archiveRootState(T, 'public')).toBe('unverified');

    const msg = await bob.mls.seal(T, 'hello from an offline-archive device');
    await fanOutCommits(ds, T, [alice]);
    expect(await alice.mls.open(T, msg)).toBe('hello from an offline-archive device');
    // And it writes nothing rather than writing a row under a key it has not
    // established.
    await expect(bob.tak.archiveOnSend(T, 'm-2', 'hello', 'public')).resolves.toEqual({
      archived: false,
      rootState: 'unverified',
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
describe('public root delivery to a later joiner', () => {
  it('REGRESSION: a device that joins later needs NOBODY to hand it the root', async () => {
    /*
     * The reported failure, and the reason the mechanism changed: delivery ran
     * only from a member who was online AND had that chat room open. With every
     * holder away, a new member's history never arrived — not slowly, never.
     * Server logs showed the joining device polling for bundles that were never
     * posted.
     *
     * Nothing distributes anything here. Alice is not even consulted.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'late-joiner';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'sent-before-bob-existed', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);

    expect(await bob.tak.archiveRootState(T, 'public')).toBe('verified');
    const history = await bob.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-1')?.plaintext).toBe('sent-before-bob-existed');
    // No bundle was posted to anyone: the old delivery path is not merely
    // unnecessary here, it is unused.
    expect([...tt.bundles.values()].flat()).toHaveLength(0);
  });

  it('a joiner reads history with every other member offline', async () => {
    // The same claim stated as the failure it prevents. Alice's client is not
    // called at all after she leaves.
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'nobody-home';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis');
    await alice.tak.archiveOnSend(T, 'm-1', 'still-readable', 'public');

    const bob = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, bob);
    const history = await bob.tak.backfill(T, 'public');
    expect(history.map((h) => h.plaintext)).toEqual(['still-readable']);
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

    // A device that cannot establish the root — the archive is unreachable, so
    // it holds no key. ('waiting' was the old shape of this: a device that had
    // not been HANDED the root. Nobody hands it over now, so the only way to
    // lack one is not to have been able to ask.)
    const newcomer = makeClient(ds, tt, 'bob');
    await join(ds, T, alice, newcomer);
    tt.offline = true;
    expect(await newcomer.tak.archiveRootState(T, 'public')).toBe('unverified');

    // Still unreachable while the gap-filler runs: the point is that a device
    // which has not established the root writes NOTHING, rather than rows only
    // it could ever open.
    expect(await newcomer.tak.backfillMissingArchive(T, 'public', [{ messageId: 'm-9', plaintext: 'nope' }])).toBe(0);
    tt.offline = false;
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

  it('the mini-app computes the same tag because it runs the same code, not a mirror of it', async () => {
    /*
     * The KDF label and length are a wire contract between web and mobile. A
     * divergence here would silently split the two into different fingerprints
     * for the same root, which reads exactly like the bug being fixed — so this
     * used to compare the two source files byte for byte.
     *
     * There is one source file now (`packages/mls/src/takClient.ts`) and both
     * trees re-export it, so "mirror" is the wrong word and byte-identity is
     * the wrong assertion. What is asserted instead is what byte-identity was
     * proxying for: `deriveRootFingerprint` reached through the mini-app path
     * IS the function reached through the web path, and the label and length it
     * closes over live in the shared file.
     */
    const mobile = await import('../../packages/mobile/src/crypto/takClient');
    expect(
      mobile.deriveRootFingerprint,
      'the mini-app resolved a different deriveRootFingerprint — the two clients can now disagree on a tag',
    ).toBe(tak.deriveRootFingerprint);
    expect(mobile.ROOT_FINGERPRINT_B64_LEN).toBe(tak.ROOT_FINGERPRINT_B64_LEN);

    // Same tag for the same root, computed through both import paths.
    const root = tak.generatePublicRootKey();
    expect(await mobile.deriveRootFingerprint(root)).toBe(await tak.deriveRootFingerprint(root));

    // The wire contract itself, read from the one file that now defines it.
    const shared = readFileSync(
      path.join(path.resolve(__dirname, '../..'), 'packages/mls/src/takClient.ts'),
      'utf-8',
    );
    expect(shared).toContain("'openstoa-archive-root-id/v1'");
    expect(shared).toContain('ROOT_FINGERPRINT_LEN = 16');
  });
});
