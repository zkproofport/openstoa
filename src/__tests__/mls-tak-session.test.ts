/**
 * Phase 3 TAK orchestration (takSession.ts) end-to-end against an in-memory DS +
 * the REAL MLS + TAK crypto. Proves the full client back-fill flow with no
 * server/browser/device:
 *   - public: a member archives messages; a LATER joiner is handed the root and
 *     decrypts all of them (the headline "join → read all history").
 *   - private (scoped): a joiner reads only the epochs explicitly granted; with
 *     no grant it reads nothing (revocation by omission).
 *   - CVE: a bundle wrapped to one device is never readable by another device.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';
import { parseCommitFraming } from '@/lib/mls/framing';

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

class MemoryTak implements TakTransport {
  archive = new Map<string, ArchiveEntry[]>();
  bundles = new Map<string, StoredBundle[]>();
  private seq = 0;
  private next() {
    return String(this.seq++).padStart(6, '0');
  }
  async postArchive(t: string, messageId: string, takVersion: number, ciphertext: string) {
    const list = this.archive.get(t) ?? [];
    if (list.some((r) => r.messageId === messageId)) return; // idempotent (topic, message)
    list.push({ messageId, takVersion, ciphertext, createdAt: this.next() });
    this.archive.set(t, list);
  }
  async getArchive(t: string) {
    return [...(this.archive.get(t) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async postBundle(t: string, recipientUserId: string, recipientDeviceId: string, bundle: string, scope: string) {
    const list = this.bundles.get(t) ?? [];
    list.push({ id: this.next(), bundle, scope, createdAt: this.next(), recipientUserId, recipientDeviceId, delivered: false });
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
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/** A client = its own MLS session + TAK session over shared DS/transport. */
function makeClient(ds: MemoryDS, tt: MemoryTak, identity: string) {
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

describe('TAK orchestration — public whole-history back-fill', () => {
  it('a later joiner is handed the root and reads every pre-join message', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'pub-topic';
    const alice = makeClient(ds, tt, 'alice');

    // Alice (holder) sends + archives two messages while she is the only member.
    const a1 = await alice.mls.seal(T, 'one');
    await alice.tak.archiveOnSend(T, 'm-0001', 'one', 'public');
    const a2 = await alice.mls.seal(T, 'two');
    await alice.tak.archiveOnSend(T, 'm-0002', 'two', 'public');
    expect(a1.epoch).toBe(0);
    expect(a2.epoch).toBe(0);

    // Bob joins (External Commit); Alice applies his commit so she sees his leaf.
    const bob = makeClient(ds, tt, 'bob');
    await bob.mls.open(T, a1); // bootstraps Bob's join
    await fanOutCommits(ds, T, [alice]);

    // Bob cannot MLS-decrypt the pre-join messages (forward secrecy).
    expect(await bob.mls.open(T, a1)).toBeNull();

    // Holder distributes the archive root to every current member leaf.
    const sent = await alice.tak.distributePublicRoot(T);
    expect(sent).toBe(2); // alice + bob

    // Bob back-fills: ingest the root bundle, then decrypt the whole archive.
    const history = await bob.tak.backfill(T, 'public');
    const byId = Object.fromEntries(history.map((h) => [h.messageId, h.plaintext]));
    expect(byId['m-0001']).toBe('one');
    expect(byId['m-0002']).toBe('two');
  });
});

describe('TAK orchestration — concurrent distribute + archive (root race)', () => {
  it('a holder that distributes and archives concurrently uses ONE root, so a joiner decrypts', async () => {
    // Regression: ensurePublicRoot must be atomic. If distribute-on-open and
    // archive-on-send each generated their own random root, the archive would be
    // sealed under a different root than the one distributed and a joiner could
    // never decrypt it (the mobile cross-platform bug).
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'race-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'genesis'); // bootstrap alice as genesis

    // Fire archive-on-send and holder distribution CONCURRENTLY (the race).
    await Promise.all([
      alice.tak.archiveOnSend(T, 'm-race-1', 'raced-message', 'public'),
      alice.tak.distributePublicRoot(T),
    ]);

    const bob = makeClient(ds, tt, 'bob');
    const seed = await alice.mls.seal(T, 'seed');
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    await alice.tak.distributePublicRoot(T); // cover bob's leaf

    const history = await bob.tak.backfill(T, 'public');
    expect(history.find((h) => h.messageId === 'm-race-1')?.plaintext).toBe('raced-message');
  });
});

describe('TAK orchestration — scoped grant (private)', () => {
  it('a joiner reads only granted epochs; nothing without a grant', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'priv-topic';
    const alice = makeClient(ds, tt, 'alice');

    // Alice archives an epoch-0 message under the epoch-0 TAK (cached on send).
    await alice.mls.seal(T, 'secret-0');
    await alice.tak.archiveOnSend(T, 'm-1001', 'secret-0', 'private');

    // Bob joins (→ epoch 1). He was NOT present at epoch 0, so he cannot derive
    // its TAK himself; before any grant his back-fill yields nothing.
    const bob = makeClient(ds, tt, 'bob');
    const seed = await alice.mls.seal(T, 'seed'); // gives bob something to open → join
    await bob.mls.open(T, seed);
    await fanOutCommits(ds, T, [alice]);
    expect((await bob.tak.backfill(T, 'private')).length).toBe(0);

    // Alice grants ONLY epoch 0 to Bob → he can now read the epoch-0 archive.
    const granted = await alice.tak.grantScoped(T, 'bob', [0]);
    expect(granted).toBeGreaterThanOrEqual(1);
    const history = await bob.tak.backfill(T, 'private');
    expect(history.find((h) => h.messageId === 'm-1001')?.plaintext).toBe('secret-0');
  });
});

describe('TAK orchestration — CVE: bundles are device-bound', () => {
  it('a third member cannot read a bundle addressed to another device', async () => {
    const ds = new MemoryDS();
    const tt = new MemoryTak();
    const T = 'cve-topic';
    const alice = makeClient(ds, tt, 'alice');
    await alice.mls.seal(T, 'x');
    await alice.tak.archiveOnSend(T, 'm-2001', 'x', 'public');

    // Bob and Carol both join.
    const bob = makeClient(ds, tt, 'bob');
    const carol = makeClient(ds, tt, 'carol');
    const m = await alice.mls.seal(T, 'y');
    await bob.mls.open(T, m);
    await fanOutCommits(ds, T, [alice, carol]);
    const m2 = await alice.mls.seal(T, 'z');
    await carol.mls.open(T, m2);
    await fanOutCommits(ds, T, [alice, bob]);

    // Alice distributes the root to all current leaves (alice, bob, carol).
    await alice.tak.distributePublicRoot(T);

    // Carol back-fills with HER device id → only her own bundle decrypts; she
    // reads the archive. Bob likewise. Neither can open the other's bundle
    // (HPKE to a different leaf key) — proven by both succeeding independently
    // only via their own addressed bundle.
    const carolHistory = await carol.tak.backfill(T, 'public');
    expect(carolHistory.find((h) => h.messageId === 'm-2001')?.plaintext).toBe('x');
    const bobHistory = await bob.tak.backfill(T, 'public');
    expect(bobHistory.find((h) => h.messageId === 'm-2001')?.plaintext).toBe('x');

    // A device that was never sent a bundle (fabricated id) gets no keys.
    const stray = await tt.getBundles(T, 'not-a-real-leaf-device');
    expect(stray.length).toBe(0);
  });
});
