/**
 * Removing a PERSON, not a device — against the real MLS crypto and an
 * in-memory Delivery Service.
 *
 * An account owns one leaf per device, so evicting one of three leaves evicts
 * nobody: the other two keep deriving every future epoch key and keep reading.
 * Everything here exists to make "you are removed" true rather than nominal.
 *
 * Edge-case matrix rows covered (test names carry the row):
 *   contract    — all of an account's leaves go in ONE commit; epoch +1, not +N
 *   integrity   — the removed account cannot open the next message; others can
 *   boundary    — 0 stale leaves burns no epoch; 1; several; duplicates
 *   hostile     — a legacy unattributable leaf is never evicted, only counted
 *   hostile     — `0xdead` is not matched by `0xdeadbeef` (prefix collision)
 *   authz-ish   — reconcile never removes the caller's OWN leaf
 *   race        — an epoch-CAS conflict re-reads the tree instead of reusing
 *                 indices that may now name different devices
 *   empty       — removeMembers([]) is refused rather than committing nothing
 */
import { describe, it, expect } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import { leafIdentity } from '@/lib/mls/leafIdentity';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { parseCommitFraming } from '@/lib/mls/framing';

const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const ALICE = '0xdeadbeef';
const BOB = '0xdead';
const CAROL = '0xc0ffee';

class MemoryDS implements MlsTransport {
  groups = new Map<string, { groupInfo: string; epoch: number; groupId: string }>();
  commits = new Map<string, CommitLogEntry[]>();
  /** Set to make the NEXT postCommit answer a CAS conflict, once. */
  conflictOnce = false;
  postedCommits = 0;
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
    this.postedCommits++;
    if (this.conflictOnce) {
      this.conflictOnce = false;
      return { ok: false };
    }
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

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** A device joins by sealing once — bootstrap runs genesis or External Commit. */
async function join(ds: MemoryDS, topic: string, identity: string): Promise<MlsSessionStore> {
  const mls = new MlsSessionStore(ds, identity, memKv());
  await mls.seal(topic, 'hello');
  return mls;
}

async function fanOut(ds: MemoryDS, topic: string, members: MlsSessionStore[]): Promise<void> {
  for (const c of await ds.getCommitsSince(topic, 0)) {
    for (const m of members) await m.applyCommit(topic, c.commit);
  }
}

describe('findLeafIndicesByUser', () => {
  it('CONTRACT: finds every device an account owns, and only those', async () => {
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const a2 = await gc.createDevice(leafIdentity(ALICE, 'ios-2'));
    const b1 = await gc.createDevice(leafIdentity(BOB, 'web-9'));

    const g = await gc.createTopicGroup('t', a1);
    let a = g.state;
    const j1 = await gc.joinTopicGroup(a2, g.groupInfoB64);
    a = await gc.processCommit(a, j1.commitB64);
    const j2 = await gc.joinTopicGroup(b1, j1.groupInfoB64);
    a = await gc.processCommit(a, j2.commitB64);

    expect(gc.findLeafIndicesByUser(a, ALICE)).toHaveLength(2);
    expect(gc.findLeafIndicesByUser(a, BOB)).toHaveLength(1);
    expect(gc.findLeafIndicesByUser(a, CAROL)).toHaveLength(0);
  });

  it('HOSTILE: a prefix of an account id does not match it', async () => {
    // BOB is `0xdead`, ALICE is `0xdeadbeef` — string containment would fuse
    // them and evict the wrong person.
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const b1 = await gc.createDevice(leafIdentity(BOB, 'web-2'));
    const g = await gc.createTopicGroup('t', a1);
    let a = g.state;
    const j = await gc.joinTopicGroup(b1, g.groupInfoB64);
    a = await gc.processCommit(a, j.commitB64);

    const alice = gc.findLeafIndicesByUser(a, ALICE);
    const bob = gc.findLeafIndicesByUser(a, BOB);
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0]).not.toBe(bob[0]);
  });

  it('HOSTILE: a LEGACY bare-device leaf belongs to nobody', async () => {
    // Guessing an owner here would evict an innocent member during a kick.
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const legacy = await gc.createDevice('web-3f1c2e00-9a55-4b21');
    const g = await gc.createTopicGroup('t', a1);
    let a = g.state;
    const j = await gc.joinTopicGroup(legacy, g.groupInfoB64);
    a = await gc.processCommit(a, j.commitB64);

    expect(gc.leafIdentities(a)).toHaveLength(2);
    expect(gc.findLeafIndicesByUser(a, ALICE)).toHaveLength(1);
    // Not attributed to the account being removed, nor to any other.
    expect(gc.findLeafIndicesByUser(a, BOB)).toHaveLength(0);
  });
});

describe('removeMembers', () => {
  it('CONTRACT: several leaves go in ONE commit — the epoch advances by exactly 1', async () => {
    /*
     * One commit per device would be wrong three times over: each commit has to
     * win its own epoch-CAS race, a failure halfway leaves the account still
     * reading on its remaining devices, and the group sees N events for one
     * removal.
     */
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const b1 = await gc.createDevice(leafIdentity(BOB, 'web-2'));
    const b2 = await gc.createDevice(leafIdentity(BOB, 'ios-3'));

    const g = await gc.createTopicGroup('t', a1);
    let a = g.state;
    const j1 = await gc.joinTopicGroup(b1, g.groupInfoB64);
    let bob1 = j1.state;
    a = await gc.processCommit(a, j1.commitB64);
    const j2 = await gc.joinTopicGroup(b2, j1.groupInfoB64);
    let bob2 = j2.state;
    a = await gc.processCommit(a, j2.commitB64);
    bob1 = await gc.processCommit(bob1, j2.commitB64);
    const before = gc.currentEpoch(a);

    const rm = await gc.removeMembers(a, gc.findLeafIndicesByUser(a, BOB));
    a = rm.state;

    expect(gc.currentEpoch(a)).toBe(before + 1);
    expect(gc.findLeafIndicesByUser(a, BOB)).toHaveLength(0);
    expect(gc.findLeafIndicesByUser(a, ALICE)).toHaveLength(1);

    // INTEGRITY: neither of the removed devices can open the next message.
    const s = await gc.sealMessage(a, 'after-removal');
    await expect(gc.openMessage(bob1, s.sealed)).rejects.toThrow();
    await expect(gc.openMessage(bob2, s.sealed)).rejects.toThrow();
  });

  it('BOUNDARY: duplicate indices collapse instead of producing a malformed commit', async () => {
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const b1 = await gc.createDevice(leafIdentity(BOB, 'web-2'));
    const g = await gc.createTopicGroup('t', a1);
    let a = g.state;
    const j = await gc.joinTopicGroup(b1, g.groupInfoB64);
    a = await gc.processCommit(a, j.commitB64);

    const idx = gc.findLeafIndicesByUser(a, BOB)[0];
    const rm = await gc.removeMembers(a, [idx, idx, idx]);
    expect(gc.findLeafIndicesByUser(rm.state, BOB)).toHaveLength(0);
  });

  it('EMPTY: an empty list is refused rather than burning an epoch to say nothing', async () => {
    const a1 = await gc.createDevice(leafIdentity(ALICE, 'web-1'));
    const g = await gc.createTopicGroup('t', a1);
    await expect(gc.removeMembers(g.state, [])).rejects.toThrow(/no leaves/);
  });
});

describe('MlsSessionStore.removeUser', () => {
  it('removes every device of the account and reports the count', async () => {
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const bobA = await join(ds, 't', leafIdentity(BOB, 'web-2'));
    const bobB = await join(ds, 't', leafIdentity(BOB, 'ios-3'));
    await fanOut(ds, 't', [alice, bobA, bobB]);

    const r = await alice.removeUser('t', BOB);
    expect(r.removed).toBe(2);
  });

  it('BOUNDARY: an account with no attributable leaves reports 0 and burns no epoch', async () => {
    /*
     * `removed: 0` is the signal that the account's devices predate the
     * `<userId>:<deviceId>` credential. Reporting it lets a caller surface the
     * gap; treating it as success would claim a removal that did not happen.
     */
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const legacy = await join(ds, 't', 'web-legacy-uuid');
    await fanOut(ds, 't', [alice, legacy]);

    const posted = ds.postedCommits;
    const r = await alice.removeUser('t', BOB);
    expect(r.removed).toBe(0);
    expect(ds.postedCommits).toBe(posted); // no commit attempted
  });
});

describe('MlsSessionStore.reconcileMembership', () => {
  it('CONTRACT: evicts leaves whose account is no longer in the member list', async () => {
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const bob = await join(ds, 't', leafIdentity(BOB, 'web-2'));
    await fanOut(ds, 't', [alice, bob]);

    // Bob's membership row is gone — server-side. The tree has to catch up.
    const r = await alice.reconcileMembership('t', [ALICE]);
    expect(r.removed).toBe(1);

    await alice.readState('t', async (s) => {
      expect(gc.findLeafIndicesByUser(s, BOB)).toHaveLength(0);
      return null;
    });
  });

  it('SELF: never removes the caller\'s own leaf, even when absent from the list', async () => {
    // A client that removes itself can no longer commit — and a stale member
    // list must not be able to make a device delete itself out of the group.
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    await fanOut(ds, 't', [alice]);

    const r = await alice.reconcileMembership('t', []);
    expect(r.removed).toBe(0);
    await alice.readState('t', async (s) => {
      expect(gc.findLeafIndicesByUser(s, ALICE)).toHaveLength(1);
      return null;
    });
  });

  it('BOUNDARY: nothing stale burns no epoch', async () => {
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const bob = await join(ds, 't', leafIdentity(BOB, 'web-2'));
    await fanOut(ds, 't', [alice, bob]);

    const posted = ds.postedCommits;
    const r = await alice.reconcileMembership('t', [ALICE, BOB]);
    expect(r.removed).toBe(0);
    expect(ds.postedCommits).toBe(posted);
  });

  it('HOSTILE: a legacy unattributable leaf is COUNTED, never evicted', async () => {
    /*
     * The dangerous direction. A leaf we cannot name might belong to a current
     * member, so evicting it on a hunch kicks an innocent person; leaving it
     * only means the sweep was incomplete, which is what the count is for.
     */
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const legacy = await join(ds, 't', 'web-legacy-uuid');
    await fanOut(ds, 't', [alice, legacy]);

    const r = await alice.reconcileMembership('t', [ALICE]);
    expect(r.removed).toBe(0);
    expect(r.unattributable).toBe(1);
    await alice.readState('t', async (s) => {
      expect(gc.leafIdentities(s)).toHaveLength(2);
      return null;
    });
  });

  it('RACE: an epoch-CAS conflict retries and still completes the eviction', async () => {
    const ds = new MemoryDS();
    const alice = await join(ds, 't', leafIdentity(ALICE, 'web-1'));
    const bob = await join(ds, 't', leafIdentity(BOB, 'web-2'));
    await fanOut(ds, 't', [alice, bob]);

    ds.conflictOnce = true;
    const r = await alice.reconcileMembership('t', [ALICE]);
    expect(r.removed).toBe(1);
    await alice.readState('t', async (s) => {
      expect(gc.findLeafIndicesByUser(s, BOB)).toHaveLength(0);
      return null;
    });
  });
});
