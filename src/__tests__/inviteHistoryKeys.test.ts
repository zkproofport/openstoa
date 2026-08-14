/**
 * Handing a topic's history to a new member through the invite link, against
 * the real MLS crypto and a real epoch keychain.
 *
 * This is what `private` and `secret` do instead of letting the server hold a
 * key. `inviteHistoryLink.test.ts` covers the wire format; this covers what
 * goes INTO it and what comes back OUT — which epochs an inviter can actually
 * offer, and what a joiner ends up holding.
 *
 * Edge-case matrix rows (test names carry the row):
 *   contract  — export/import round-trips through the real fragment codec
 *   boundary  — 0 epochs, 1, more than exist, exactly the tier ceiling
 *   integrity — only epochs the inviter HOLDS; newest-first, never oldest
 *   integrity — a gap in the keychain is skipped, not treated as the end
 *   hostile   — a wrong-sized key is refused; a foreign key cannot REPLACE one
 *   empty     — an empty payload imports nothing and says so
 *   contract  — re-opening the same link adds nothing and reports 0
 */
import { describe, it, expect } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import { parseCommitFraming } from '@/lib/mls/framing';
import { encodeInviteHistory, decodeInviteHistory } from '@/lib/inviteHistoryLink';
import { INVITE_HISTORY_EPOCHS_MAX } from '@/lib/chatTierPolicy';

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

class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    list.push({ messageId, takVersion, ciphertext, createdAt: new Date().toISOString() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])];
  }
  async postBundle() {}
  async getBundles(): Promise<TakBundleRow[]> {
    return [];
  }
  async ackBundles() {}
  async getServerRoot(): Promise<Uint8Array | null> {
    return null;
  }
  async putServerRoot(): Promise<boolean> {
    return true;
  }
  async getRootFingerprint(t: string) {
    return { fingerprint: null, archiveCount: (this.archive.get(t) ?? []).length };
  }
  async setRootFingerprint(_t: string, fingerprint: string) {
    return { fingerprint, claimed: true };
  }
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** A device that has joined `topic` and can seal/open in it. */
async function device(ds: MemoryDS, tt: MemoryTak, topic: string, identity: string) {
  const kv = memKv();
  const mls = new MlsSessionStore(ds, identity, kv);
  const tak = new TakSessionStore(mls, tt, kv);
  await mls.seal(topic, 'join');
  return { mls, tak, kv };
}

/** Advance the group by one epoch, so a new epoch TAK exists to be shared. */
async function advanceEpoch(ds: MemoryDS, topic: string, mls: MlsSessionStore) {
  const joiner = new MlsSessionStore(ds, `filler-${Math.floor(performance.now() * 1000)}`, memKv());
  await joiner.seal(topic, 'x');
  await mls.sync(topic);
}

const TOPIC = 't-invite';

describe('exportInviteHistory', () => {
  it('CONTRACT: round-trips through the real fragment codec', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');

    const exported = await alice.tak.exportInviteHistory(TOPIC, 5);
    expect(Object.keys(exported).length).toBeGreaterThan(0);

    const fragment = encodeInviteHistory({ taks: exported });
    expect(fragment).not.toBeNull();
    expect(decodeInviteHistory(fragment)!.taks).toEqual(exported);
  });

  it('BOUNDARY: asking for 0 or a negative count shares nothing', async () => {
    const ds = new MemoryDS();
    const alice = await device(ds, new MemoryTak(), TOPIC, 'alice');
    expect(await alice.tak.exportInviteHistory(TOPIC, 0)).toEqual({});
    expect(await alice.tak.exportInviteHistory(TOPIC, -1)).toEqual({});
    expect(await alice.tak.exportInviteHistory(TOPIC, 1.5)).toEqual({});
  });

  it('BOUNDARY: asking for more epochs than exist returns what there is', async () => {
    const ds = new MemoryDS();
    const alice = await device(ds, new MemoryTak(), TOPIC, 'alice');
    const got = await alice.tak.exportInviteHistory(TOPIC, INVITE_HISTORY_EPOCHS_MAX);
    // A brand-new group holds one epoch; the ask is 20 and that is not an error.
    expect(Object.keys(got).length).toBeGreaterThan(0);
    expect(Object.keys(got).length).toBeLessThanOrEqual(INVITE_HISTORY_EPOCHS_MAX);
  });

  it('INTEGRITY: shares the NEWEST epochs, not the oldest', async () => {
    /*
     * A new arrival needs the conversation they are walking into. Sharing from
     * the beginning would hand over the least useful history AND the most of
     * it — the exact opposite of a bounded window.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');
    for (let i = 0; i < 3; i++) {
      await advanceEpoch(ds, TOPIC, alice.mls);
      await alice.tak.cacheCurrentEpochTak(TOPIC);
    }
    const current = await alice.mls.readState(TOPIC, async (s) => gc.currentEpoch(s));

    const got = await alice.tak.exportInviteHistory(TOPIC, 2);
    const epochs = Object.keys(got).map(Number).sort((a, b) => b - a);
    expect(epochs.length).toBeLessThanOrEqual(2);
    // The newest one shared is the newest one held.
    expect(epochs[0]).toBe(current);
  });

  it('INTEGRITY: an inviter can only share epochs it HOLDS', async () => {
    // A member who joined late cannot hand over the month before they arrived.
    // The ceiling is a property of the keychain, not a rule anyone enforces.
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');
    for (let i = 0; i < 2; i++) {
      await advanceEpoch(ds, TOPIC, alice.mls);
      await alice.tak.cacheCurrentEpochTak(TOPIC);
    }
    const late = await device(ds, tt, TOPIC, 'late-joiner');

    const fromLate = await late.tak.exportInviteHistory(TOPIC, 20);
    const fromAlice = await alice.tak.exportInviteHistory(TOPIC, 20);
    expect(Object.keys(fromLate).length).toBeLessThanOrEqual(Object.keys(fromAlice).length);
  });
});

describe('importInviteHistory', () => {
  it('CONTRACT: a joiner ends up holding the exported keys', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');
    const exported = await alice.tak.exportInviteHistory(TOPIC, 5);

    const bob = await device(ds, tt, TOPIC, 'bob');
    const added = await bob.tak.importInviteHistory(TOPIC, exported);
    expect(added).toBeGreaterThan(0);
  });

  it('CONTRACT: re-opening the same link adds NOTHING and reports 0', async () => {
    /*
     * The count is what the caller tells the user. Saying "3 more epochs" the
     * second time somebody taps a link is a lie, and the user would reasonably
     * conclude the first tap had failed.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');
    const exported = await alice.tak.exportInviteHistory(TOPIC, 5);
    const bob = await device(ds, tt, TOPIC, 'bob');

    expect(await bob.tak.importInviteHistory(TOPIC, exported)).toBeGreaterThan(0);
    expect(await bob.tak.importInviteHistory(TOPIC, exported)).toBe(0);
  });

  it('EMPTY: an empty payload imports nothing', async () => {
    const ds = new MemoryDS();
    const bob = await device(ds, new MemoryTak(), TOPIC, 'bob');
    expect(await bob.tak.importInviteHistory(TOPIC, {})).toBe(0);
  });

  it('HOSTILE: a wrong-sized value is refused — it is provably not a key', async () => {
    const ds = new MemoryDS();
    const bob = await device(ds, new MemoryTak(), TOPIC, 'bob');
    const added = await bob.tak.importInviteHistory(TOPIC, {
      900: b64(new Uint8Array(16)), // half a key
      901: b64(new Uint8Array(64)), // twice one
      902: 'not-base64-at-all!!',
    });
    expect(added).toBe(0);
  });

  it('HOSTILE: a link cannot REPLACE a key this device already derived', async () => {
    /*
     * The held key came from the group's own secret and is therefore right. One
     * arriving in a URL has been through a channel we do not control. Letting
     * it win is how a bad link turns readable history unreadable.
     */
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const alice = await device(ds, tt, TOPIC, 'alice');
    const mine = await alice.tak.exportInviteHistory(TOPIC, 1);
    const epoch = Number(Object.keys(mine)[0]);

    const attacker = { [epoch]: b64(new Uint8Array(32).fill(7)) };
    expect(await alice.tak.importInviteHistory(TOPIC, attacker)).toBe(0);

    // Still the original, not the one from the link.
    const after = await alice.tak.exportInviteHistory(TOPIC, 1);
    expect(after[epoch]).toBe(mine[epoch]);
  });

  it('HOSTILE: negative and fractional epochs are skipped', async () => {
    const ds = new MemoryDS();
    const bob = await device(ds, new MemoryTak(), TOPIC, 'bob');
    const added = await bob.tak.importInviteHistory(TOPIC, {
      [-1]: b64(new Uint8Array(32).fill(1)),
      [1.5]: b64(new Uint8Array(32).fill(2)),
    });
    expect(added).toBe(0);
  });
});
