/**
 * Tests the browser MLS session manager (mlsSession.ts) end-to-end against an
 * in-memory Delivery Service that mirrors the real server contract — it uses
 * the REAL framing parser (parseCommitFraming) + epoch-CAS, so client-produced
 * External Commits are validated exactly as the server would. Proves bootstrap
 * (genesis + self-service join), catch-up, bidirectional E2EE, and forward
 * secrecy of pre-join messages.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
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
    if (this.groups.has(t)) return false; // ON CONFLICT DO NOTHING
    this.groups.set(t, { groupInfo: gi, epoch: 0, groupId: gid });
    this.commits.set(t, []);
    return true;
  }
  async postCommit(t: string, commitB64: string, giB64: string) {
    const g = this.groups.get(t);
    if (!g) return { ok: false };
    const framing = parseCommitFraming(unb64(commitB64)); // real server-side parse
    if (framing.epoch !== g.epoch) return { ok: false }; // epoch-CAS conflict
    g.epoch = framing.epoch + 1;
    g.groupInfo = giB64;
    this.commits.get(t)!.push({ epoch: g.epoch, commit: commitB64, welcome: null });
    return { ok: true, epoch: g.epoch };
  }
  async getCommitsSince(t: string, since: number) {
    return (this.commits.get(t) ?? []).filter((c) => c.epoch > since);
  }
}

describe('MlsSessionStore — bootstrap, join, catch-up, E2EE', () => {
  it('genesis + self-service join + bidirectional E2EE, with pre-join FS', async () => {
    const ds = new MemoryDS();
    const T = 'topic-x';
    const alice = new MlsSessionStore(ds, 'alice');
    const bob = new MlsSessionStore(ds, 'bob');

    // Alice's first seal bootstraps her as genesis (epoch 0, alone).
    const ping = await alice.seal(T, 'ping-epoch0');
    expect(ping.epoch).toBe(0);

    // Bob's first open bootstraps him via External Commit (epoch 0 → 1). He
    // cannot read Alice's pre-join epoch-0 message (forward secrecy).
    const r0 = await bob.open(T, ping);
    expect(r0).toBeNull();

    // The server now holds Bob's join commit; Alice applies it (as via SSE).
    const commits = await ds.getCommitsSince(T, 0);
    expect(commits.length).toBe(1);
    await alice.applyCommit(T, commits[0].commit);

    // Both at epoch 1 → messages flow both ways and decrypt.
    const m1 = await alice.seal(T, 'hello-bob');
    expect(m1.epoch).toBe(1);
    expect(await bob.open(T, m1)).toBe('hello-bob');

    const m2 = await bob.seal(T, 'hi-alice');
    expect(await alice.open(T, m2)).toBe('hi-alice');
  });

  it('loser of a genesis race joins the winner group instead', async () => {
    // Pre-seed a group as if another member already genesis'd.
    const ds = new MemoryDS();
    const T = 'topic-y';
    const founder = new MlsSessionStore(ds, 'founder');
    await founder.seal(T, 'seed'); // founder is genesis

    // A second store boots: GET group-info returns the founder's → it joins.
    const joiner = new MlsSessionStore(ds, 'joiner');
    const probe = await joiner.seal(T, 'from-joiner'); // bootstraps via join, then seals
    expect(probe.epoch).toBeGreaterThanOrEqual(1);

    // Founder catches up on the joiner's commit, then reads the joiner message.
    for (const c of await ds.getCommitsSince(T, 0)) await founder.applyCommit(T, c.commit);
    expect(await founder.open(T, probe)).toBe('from-joiner');
  });

  it('persists ClientState — a restarted store restores the same leaf (no re-join)', async () => {
    const ds = new MemoryDS();
    const kv = new Map<string, string>();
    const store: SecureKVStore = {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => void kv.set(k, v),
    };
    const T = 'topic-persist';

    // alice (with persistence) genesis; bob joins; both reach epoch 1.
    const alice = new MlsSessionStore(ds, 'alice', store);
    const ping = await alice.seal(T, 'ping'); // genesis epoch 0, state persisted
    const bob = new MlsSessionStore(ds, 'bob');
    await bob.open(T, ping); // bob joins via External Commit (epoch 1)
    for (const c of await ds.getCommitsSince(T, 0)) await alice.applyCommit(T, c.commit);
    const m1 = await alice.seal(T, 'before-restart');
    expect(await bob.open(T, m1)).toBe('before-restart');
    expect(kv.size).toBeGreaterThan(0); // state was persisted

    // Simulate an app restart: a brand-new store instance with the SAME secure
    // KV + transport. It must RESTORE alice's leaf, not re-join (which would add
    // a new commit and strand the old leaf).
    const commitsBefore = (await ds.getCommitsSince(T, 0)).length;
    const aliceRestarted = new MlsSessionStore(ds, 'alice', store);
    const m2 = await aliceRestarted.seal(T, 'after-restart');
    const commitsAfter = (await ds.getCommitsSince(T, 0)).length;

    expect(commitsAfter).toBe(commitsBefore); // no re-join commit → restored, not rebooted
    expect(await bob.open(T, m2)).toBe('after-restart'); // restored leaf still seals validly

    // And the restored leaf still RECEIVES: a new message from bob decrypts on
    // the restarted store — i.e. messages a member receives survive an app
    // restart (the user-facing point of persistence). bob catches up to the
    // restored alice's epoch first so both are aligned.
    for (const c of await ds.getCommitsSince(T, 0)) await bob.applyCommit(T, c.commit);
    const m3 = await bob.seal(T, 'received-after-restart');
    expect(await aliceRestarted.open(T, m3)).toBe('received-after-restart');
  });

  it('openCached caches plaintext so history survives even when MLS can no longer decrypt', async () => {
    const ds = new MemoryDS();
    const cache = new Map<string, string>();
    const msgCache: SecureKVStore = {
      get: async (k) => cache.get(k) ?? null,
      set: async (k, v) => void cache.set(k, v),
    };
    const T = 'topic-msgcache';

    // alice (with a message cache) + bob reach epoch 1.
    const alice = new MlsSessionStore(ds, 'alice', undefined, msgCache);
    const bob = new MlsSessionStore(ds, 'bob');
    const ping = await alice.seal(T, 'ping');
    await bob.open(T, ping);
    for (const c of await ds.getCommitsSince(T, 0)) await alice.applyCommit(T, c.commit);

    // bob sends; alice openCached decrypts AND caches the plaintext.
    const m1 = await bob.seal(T, 'hello-cached');
    expect(await alice.openCached(T, 'msg-1', m1)).toBe('hello-cached');
    expect(cache.size).toBe(1);

    // A "restarted" client that shares the message cache but has NO MLS state
    // able to decrypt m1 (a different, never-joined leaf) still returns the
    // cached plaintext — i.e. history survives once the MLS key is gone.
    const restarted = new MlsSessionStore(ds, 'never-joined', undefined, msgCache);
    expect(await restarted.openCached(T, 'msg-1', m1)).toBe('hello-cached');
  });
});
