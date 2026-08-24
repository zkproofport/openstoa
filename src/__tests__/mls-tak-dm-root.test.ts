/**
 * A DM's archive key: one root for the conversation, minted once, and handed
 * device to device — against an in-memory DS and the REAL MLS + TAK crypto.
 *
 * The defect this file exists for: `takSession` chose its key model from a
 * topic's VISIBILITY, and a DM row carries `visibility: 'secret'`, so every DM
 * message was sealed under a per-epoch key while `chatTierPolicy` declared DMs
 * used a single topic-wide root. The epoch key never left the device that minted
 * it, so a DM decrypted nowhere except the browser that sealed it — and because
 * 'dm' is not a visibility, nothing typed the contradiction.
 *
 * Everything here is `'dm'` as the TIER, which is the input the fix introduced.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract        → a peer whose device joins AFTER the messages reads them all
 *   contract        → the messages sealed BEFORE and AFTER the hand-over both
 *                     open with the one key, which is the property `topic-root`
 *                     buys over `per-epoch` and the reason for choosing it
 *   contract        → a DM's key model comes from the policy, so `'dm'` and
 *                     `'secret'` take DIFFERENT paths despite the same row
 *   authorization   → a bundle wrapped to one device is unreadable by another
 *   integrity       → two devices minting at once converge on ONE root, and the
 *                     loser stops sealing under its own rather than orphaning
 *   integrity       → the root is NEVER offered to the server: `putServerRoot`
 *                     throws in this fixture, and the flow never calls it
 *   external dep    → a fingerprint lookup that FAILS never mints (fail safe)
 *   boundary        → a DM with no archive rows back-fills to []
 *   empty/null      → a device holding nothing reports `waiting`, not `verified`
 *   hostile / UTF-8 / large → N/A here: this file moves keys. Body content is
 *                     exercised over real HTTP in
 *                     `packages/sdk/src/__tests__/e2e/dm-keys.e2e.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import { parseCommitFraming } from '@/lib/mls/framing';

const b64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
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
 * The DS as a DM sees it: bundles and archive rows move, and the two
 * server-held-key routes REFUSE.
 *
 * The refusals are the point. A fake that quietly accepted `putServerRoot` would
 * certify a client that leaks a DM's key to the server as working — the exact
 * failure mode the repo has shipped four times (see `openstoa-dev.md`). Here the
 * server answering 403 is modelled as a throw, so any code path that reaches for
 * it fails the test loudly instead of passing quietly.
 */
class MemoryDmTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  bundles = new Map<string, StoredBundle[]>();
  fingerprints = new Map<string, string>();
  /** Set to make the fingerprint endpoint unreachable (the offline case). */
  fingerprintOffline = false;
  private seq = 0;
  private next() {
    return String(this.seq++).padStart(6, '0');
  }
  /**
   * The fingerprint this topic had published AT THE MOMENT its first row was
   * written, recorded rather than asserted afterwards.
   *
   * The ordering is what makes `computePeerRoot` safe to let a rootless device
   * claim: if a fingerprint is always published BEFORE anything can be sealed
   * under a topic root, then `fingerprint === null && archiveCount > 0` cannot
   * denote topic-root rows. Checked after the fact, that ordering is invisible
   * — the fingerprint is there either way by the time the test looks.
   */
  fingerprintAtFirstArchive = new Map<string, string | null>();
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    if (list.length === 0) this.fingerprintAtFirstArchive.set(t, this.fingerprints.get(t) ?? null);
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async postBundle(t: string, recipientUserId: string, recipientDeviceId: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    if (list.some((b) => b.recipientDeviceId === recipientDeviceId && b.scope === scope && !b.delivered)) return;
    list.push({ id: this.next(), bundle, scope, createdAt: new Date().toISOString(), recipientUserId, recipientDeviceId, delivered: false });
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
  /** `GET /archive/root` answers 403 for a DM; the SDK maps that to null. */
  async getServerRoot(): Promise<Uint8Array | null> {
    return null;
  }
  /** `PUT /archive/root` answers 403 for a DM. Reaching it at all is the bug. */
  async putServerRoot(): Promise<boolean> {
    throw new Error('the server must never be offered a DM archive root');
  }
  async getRootFingerprint(t: string) {
    if (this.fingerprintOffline) throw new Error('root-fingerprint GET failed');
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

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeClient(ds: MemoryDS, tt: MemoryDmTak, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  return { mls, tak };
}

async function fanOutCommits(ds: MemoryDS, topic: string, members: { mls: MlsSessionStore }[]) {
  for (const c of await ds.getCommitsSince(topic, 0)) {
    for (const m of members) await m.mls.applyCommit(topic, c.commit);
  }
}

const bodies = (rows: Array<{ messageId: string; plaintext: string }>) =>
  Object.fromEntries(rows.map((r) => [r.messageId, r.plaintext]));

describe('DM archive root — the peer who joins later', () => {
  it('CONTRACT: reads every message, including the ones sent before its device existed', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-topic';
    const alice = makeClient(ds, tt, 'alice');

    // Alice opens the DM and says two things while she is the only leaf.
    const first = await alice.mls.seal(T, 'one');
    await alice.tak.archiveOnSend(T, 'm-1', 'one', 'dm');
    await alice.mls.seal(T, 'two');
    await alice.tak.archiveOnSend(T, 'm-2', 'two', 'dm');

    // Bob's device joins (External Commit → a new epoch).
    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, first);
    await fanOutCommits(ds, T, [alice]);

    // Forward secrecy: the live ciphertext is not readable to a leaf that did
    // not exist when it was sealed. The archive is the whole mechanism.
    expect(await bob.mls.open(T, first)).toBeNull();
    expect((await bob.tak.backfill(T, 'dm')).length).toBe(0);

    // Alice hands the root to every current leaf — the `'peer-device'` delivery.
    expect(await alice.tak.distributeRootWhenGroupChanged(T, 'dm')).toBe(2);

    expect(bodies(await bob.tak.backfill(T, 'dm'))).toEqual({ 'm-1': 'one', 'm-2': 'two' });
  });

  it('CONTRACT: one key opens what came before the hand-over AND what comes after', async () => {
    /*
     * The property `topic-root` buys over `per-epoch`, and the reason for
     * choosing it. Under per-epoch keys this message would need a SECOND grant
     * covering the new epoch, and a hole opened by a missed grant is silent —
     * which is exactly what a DM, the room whose promise is "your conversation
     * follows you", cannot afford.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-before-after';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');
    await alice.tak.archiveOnSend(T, 'm-before', 'said before you arrived', 'dm');

    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    await alice.tak.distributeRootWhenGroupChanged(T, 'dm');

    // A third device joins, advancing the epoch again, and Alice speaks after.
    const alicePhone = makeClient(ds, tt, 'alice');
    const seed2 = await alice.mls.seal(T, 'seed2');
    await alicePhone.mls.open(T, seed2);
    await fanOutCommits(ds, T, [alice, bob]);
    await alice.mls.seal(T, 'later');
    await alice.tak.archiveOnSend(T, 'm-after', 'said after you arrived', 'dm');

    // Bob was granted nothing further, and reads both anyway.
    expect(bodies(await bob.tak.backfill(T, 'dm'))).toEqual({
      'm-before': 'said before you arrived',
      'm-after': 'said after you arrived',
    });
  });

  it("CONTRACT: the SENDER's other device reads what the first one sealed", async () => {
    // An MLS sender can never re-open its own application message, so a second
    // device of the same account has no route to it but the archive.
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-own-devices';
    const laptop = makeClient(ds, tt, 'alice');
    const seed = await laptop.mls.seal(T, 'seed');
    await laptop.tak.archiveOnSend(T, 'm-own', 'from my laptop', 'dm');

    const phone = makeClient(ds, tt, 'alice');
    await phone.mls.open(T, seed);
    await fanOutCommits(ds, T, [laptop]);
    await laptop.tak.distributeRootWhenGroupChanged(T, 'dm');

    expect(bodies(await phone.tak.backfill(T, 'dm'))['m-own']).toBe('from my laptop');
  });
});

describe('DM archive root — the tier decides, not the visibility', () => {
  it('REGRESSION: the same row read as `dm` and as `secret` takes different paths', async () => {
    /*
     * The bug in one assertion. A DM is stored `visibility: 'secret'`; passing
     * that visibility gave per-epoch keys, and the key stayed on one device. The
     * ONLY difference between these two runs is the tier passed in.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-vs-secret';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');
    await alice.tak.archiveOnSend(T, 'm-1', 'body', 'dm');

    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    await alice.tak.distributeRootWhenGroupChanged(T, 'dm');

    // As a DM: the root arrived, so the row opens.
    expect(bodies(await bob.tak.backfill(T, 'dm'))['m-1']).toBe('body');
    // Read as `secret`, the same row is looked up under an epoch key that was
    // never granted — which is what every DM used to do.
    expect(bodies(await bob.tak.backfill(T, 'secret'))['m-1']).toBeUndefined();
  });

  it('CONTRACT: a DM has an archive-root state; a per-epoch tier has none', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-state';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'seed');

    expect(await alice.tak.archiveRootState(T, 'secret')).toBeNull();
    expect(await alice.tak.archiveRootState(T, 'private')).toBeNull();
    expect(await alice.tak.archiveRootState(T, 'dm')).toBe('verified');
  });

  it('EMPTY: a device holding nothing is `waiting`, and seals nothing under a guess', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-waiting';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');
    await alice.tak.archiveOnSend(T, 'm-1', 'mine', 'dm');

    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);

    // Not 'verified' — Bob holds nothing — and not a mint, which would orphan
    // Alice's row under a second root nobody else has.
    expect(await bob.tak.archiveRootState(T, 'dm')).toBe('waiting');
    expect((await bob.tak.archiveOnSend(T, 'm-2', 'ours?', 'dm')).archived).toBe(false);
    expect(tt.fingerprints.size).toBe(1);
  });

  it('BOUNDARY: a DM with nothing archived back-fills to nothing', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-quiet';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'seed');

    await expect(alice.tak.backfill(T, 'dm')).resolves.toEqual([]);
  });
});

describe('DM archive root — races and refusals', () => {
  it('INTEGRITY: two devices minting at once agree on ONE root', async () => {
    /*
     * There is no server to arbitrate a DM's key, so the fingerprint
     * compare-and-set is the arbiter. Two roots would mean each device could
     * read only what it sealed itself, permanently, with nothing reporting it.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-race';
    const laptop = makeClient(ds, tt, 'alice');
    const seed = await laptop.mls.seal(T, 'seed');
    const phone = makeClient(ds, tt, 'alice');
    await phone.mls.open(T, seed);
    await fanOutCommits(ds, T, [laptop]);

    const [a, b] = await Promise.all([
      laptop.tak.archiveOnSend(T, 'm-laptop', 'from the laptop', 'dm'),
      phone.tak.archiveOnSend(T, 'm-phone', 'from the phone', 'dm'),
    ]);

    // Exactly one fingerprint is published, so exactly one root is the DM's.
    expect(tt.fingerprints.size).toBe(1);
    // The loser did not archive under a root nobody else holds.
    expect([a.archived, b.archived].filter(Boolean).length).toBeGreaterThanOrEqual(1);

    // And once the winner distributes, both devices read everything that landed.
    await laptop.tak.distributeRoot(T, 'dm');
    await phone.tak.distributeRoot(T, 'dm');
    const archivedIds = (await tt.getArchive(T)).map((r) => r.messageId);
    for (const [who, client] of [
      ['laptop', laptop],
      ['phone', phone],
    ] as const) {
      const seen = bodies(await client.tak.backfill(T, 'dm'));
      for (const id of archivedIds) expect(seen[id], `${who} cannot read ${id}`).toBeTruthy();
    }
  });

  it('AUTHZ: a bundle wrapped to one device is unreadable by another', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-wrap';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');
    await alice.tak.archiveOnSend(T, 'm-1', 'private words', 'dm');

    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    await alice.tak.distributeRoot(T, 'dm');

    // Hand Bob's bundle to Mallory's session verbatim. HPKE is to the LEAF, so
    // holding the bytes is not holding the key.
    const bobDevice = await bob.tak.myDeviceId(T);
    const forBob = (await tt.getBundles(T, bobDevice))[0];
    expect(forBob, 'no bundle was addressed to bob').toBeTruthy();
    const mallory = makeClient(ds, tt, 'mallory');
    const seed2 = await alice.mls.seal(T, 'seed2');
    await mallory.mls.open(T, seed2);
    await fanOutCommits(ds, T, [alice, bob]);
    const malloryDevice = await mallory.tak.myDeviceId(T);
    await tt.postBundle(T, 'mallory', malloryDevice, forBob.bundle, forBob.scope);

    expect(bodies(await mallory.tak.backfill(T, 'dm'))['m-1']).toBeUndefined();
  });

  it('EXTERNAL FAILURE: an unreachable fingerprint endpoint never mints', async () => {
    /*
     * Fail safe. A root minted without a check looks valid to this device
     * forever and orphans everything sealed under it — the failure that is
     * invisible until someone else tries to read.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-offline';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'seed');
    tt.fingerprintOffline = true;

    expect(await alice.tak.archiveRootState(T, 'dm')).toBe('unverified');
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'x', 'dm')).archived).toBe(false);
    expect(await alice.tak.sealForPush(T, 'x', 'dm')).toBeNull();
    expect(tt.fingerprints.size).toBe(0);

    // Back online, it mints and archives normally.
    tt.fingerprintOffline = false;
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'x', 'dm')).archived).toBe(true);
  });

  it('INTEGRITY: the root is never offered to the server', async () => {
    // `putServerRoot` throws in this fixture, so any path that reaches for the
    // server-held-key route fails here rather than silently disabling E2EE.
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-no-server-key';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');
    await expect(alice.tak.archiveOnSend(T, 'm-1', 'x', 'dm')).resolves.toEqual({
      archived: true,
      rootState: 'verified',
    });

    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    await expect(alice.tak.distributeRoot(T, 'dm')).resolves.toBe(2);
    await expect(bob.tak.backfill(T, 'dm')).resolves.toHaveLength(1);
  });
});

describe('DM archive root — a conversation that already has history', () => {
  it('REGRESSION: rows already archived, no fingerprint — the DM still settles on a root', async () => {
    /*
     * THE CASE THE ORIGINAL SUITE DID NOT HAVE, and the reason the deadlock
     * shipped: every DM those twelve tests create is FRESH, so `archiveCount`
     * is 0 and the guard below is never reached. The one arrangement that
     * breaks is the one no test built.
     *
     * The arrangement is not hypothetical — it is the state of every DM that
     * carried a single message before the tier fix. Pre-fix, a DM's key model
     * came from its ROW's `visibility: 'secret'`, so it took the per-epoch
     * branch and wrote `chat_archive` rows under epoch keys, while the
     * fingerprint route refused DMs outright so `archive_root_fingerprint`
     * stayed NULL. `archiveOnSend(..., 'secret')` below reproduces exactly that,
     * through the shipped code rather than by hand-seeding a row.
     *
     * What the guard then did: rows exist ⇒ "a root must already exist" ⇒ only a
     * device holding it may claim ⇒ but the only way to HOLD one is to claim, or
     * to be handed one by a peer whose own root is verified. Every device of
     * both participants sat in `waiting`, forever, and it compounded —
     * `currentArchiveKey` hands back no key unless verified, so messages sent
     * after the deploy were not archived either.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-legacy-archive';
    const alice = makeClient(ds, tt, 'alice');
    const seed = await alice.mls.seal(T, 'seed');

    await alice.tak.archiveOnSend(T, 'legacy-1', 'said before the fix', 'secret');
    expect((await tt.getArchive(T)).length).toBe(1);
    expect(tt.fingerprints.size, 'a DM never had a fingerprint before the fix').toBe(0);

    // Pre-fix this is 'waiting' — on this device and on every other one.
    expect(await alice.tak.archiveRootState(T, 'dm')).toBe('verified');
    expect((await alice.tak.archiveOnSend(T, 'm-1', 'after the fix', 'dm')).archived).toBe(true);

    // And the peer is unblocked too, which is the half that makes it a DM again
    // rather than a room one device can write to.
    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    expect(await alice.tak.distributeRootWhenGroupChanged(T, 'dm')).toBe(2);
    expect(bodies(await bob.tak.backfill(T, 'dm'))).toEqual({ 'm-1': 'after the fix' });

    /*
     * `legacy-1` is NOT recovered, by anyone, including the device that sealed
     * it: it is under an epoch key, and a topic-root tier's backfill never
     * reaches for one. That ciphertext is dead and stays dead — the code cannot
     * fix it, which is why `scripts/delete-dm-chat-archive.ts` exists. Worse
     * than merely unreadable: `chat_archive` is unique on (topic_id,
     * message_id), so the row also blocks `backfillMissingArchive` from ever
     * re-sealing that message under the root it CAN read.
     */
    expect(bodies(await alice.tak.backfill(T, 'dm'))['legacy-1']).toBeUndefined();
  });

  it('INTEGRITY: the fingerprint is published BEFORE anything is sealed under the root', async () => {
    /*
     * The invariant that makes the change above safe, pinned as an ORDERING
     * rather than as an end state — after the fact the fingerprint is there
     * either way, so an assertion at the end proves nothing.
     *
     * Because a row can only be sealed under a topic root AFTER that root's
     * fingerprint is published, `fingerprint === null && archiveCount > 0`
     * cannot mean "topic-root rows exist". On this path it can only mean rows
     * from the per-epoch era, which no root will ever open. That is why the
     * count alone must not block a claim.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-fingerprint-first';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'seed');

    await alice.tak.archiveOnSend(T, 'm-1', 'x', 'dm');
    expect(tt.fingerprintAtFirstArchive.get(T)).not.toBeNull();
    expect(tt.fingerprintAtFirstArchive.get(T)).toBe(tt.fingerprints.get(T));
  });

  it('ORPHAN: a held root that opens none of the existing rows still refuses to claim', async () => {
    /*
     * The half of the guard that stays. Dropping the `waiting` line does not
     * drop this: a device that HOLDS a root which cannot open row #1 is provably
     * not holding the archive's root, and letting it publish its own would
     * rename the conversation's identity to a key that opens none of its
     * history.
     *
     * Reachable, not decorative. `shouldAdoptRoot` adopts a bundle's root
     * outright when no fingerprint is published (takSession.ts, `if (!local)
     * return true`), and `webTransport` reports `fingerprint: null` for a 404 —
     * so a root can be in the store while the published identity reads null. A
     * restored keychain (`importKeychain`, the recovery path) gets there too,
     * which is what this builds.
     */
    const ds = new MemoryDS();
    const tt = new MemoryDmTak();
    const T = 'dm-orphan-root';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'seed');
    await alice.tak.archiveOnSend(T, 'm-1', 'the real history', 'dm');
    // Reproduce "rows exist, published identity reads null" without inventing a
    // row shape: the rows are real and really sealed under Alice's root.
    tt.fingerprints.delete(T);

    const restored = makeClient(ds, tt, 'mallory');
    // `tak.root.<topicId>` is the store's own name for the topic root; a
    // keychain restore writes exactly this. If the name ever changes, the
    // planted root is simply not found and this test fails loudly rather than
    // passing for the wrong reason.
    const foreign = new Uint8Array(32).fill(7);
    await restored.tak.importKeychain({ [`tak.root.${T}`]: b64(foreign) });

    expect(await restored.tak.archiveRootState(T, 'dm')).toBe('orphan');
    expect((await restored.tak.archiveOnSend(T, 'm-2', 'must not be sealed', 'dm')).archived).toBe(false);
    expect(tt.fingerprints.size, 'an orphan root must not become the DM identity').toBe(0);
  });
});
