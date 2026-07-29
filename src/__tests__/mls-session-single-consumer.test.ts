/**
 * Regression guard for the "[unable to decrypt]" chat defect.
 *
 * MLS deletes each per-message key the moment the message is decrypted
 * (forward secrecy), so a sealed message can be MLS-opened exactly ONCE.
 * `openCached` papers over that for sequential reads by caching the plaintext,
 * but the cache is read-then-write: two readers that start before either has
 * written both miss, both call open(), and the loser gets null → the UI renders
 * '[unable to decrypt]'.
 *
 * The consequence for the web client is an invariant, not a nicety: exactly one
 * ChatPanel may be mounted at a time. Two panels (the desktop dock + the mobile
 * sheet, both previously mounted at every viewport and merely CSS-hidden) each
 * fetch history and each hold an SSE stream, so they race on every message.
 * These tests pin the underlying behaviour so that regression is caught here.
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

function memoryKV(): SecureKVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
  };
}

/** Build a joined 2-member group and return a message alice sealed for bob. */
async function sealedForBob(bobCache?: SecureKVStore) {
  const ds = new MemoryDS();
  const T = 'topic-single-consumer';
  const alice = new MlsSessionStore(ds, 'alice');
  const bob = new MlsSessionStore(ds, 'bob', undefined, bobCache);

  // Bootstrap: alice genesis, bob joins via External Commit, alice catches up.
  const seed = await alice.seal(T, 'seed');
  await bob.open(T, seed); // pre-join → null, but joins the group
  for (const c of await ds.getCommitsSince(T, 0)) await alice.applyCommit(T, c.commit);

  const sealed = await alice.seal(T, 'hello-bob');
  return { T, bob, sealed };
}

describe('MLS one-shot decrypt — why only ONE chat panel may be mounted', () => {
  it('two CONCURRENT openCached of the same message: one wins, the other is undecryptable', async () => {
    const cache = memoryKV();
    const { T, bob, sealed } = await sealedForBob(cache);

    // Exactly what two mounted ChatPanels do: both receive the same SSE message
    // and both call openCached before either has written the plaintext cache.
    const [a, b] = await Promise.all([
      bob.openCached(T, 'msg-1', sealed),
      bob.openCached(T, 'msg-1', sealed),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r === 'hello-bob')).toHaveLength(1);
    // The loser is null — the UI turns this into '[unable to decrypt]'.
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it('SEQUENTIAL openCached of the same message succeeds twice — the cache covers reloads', async () => {
    const cache = memoryKV();
    const { T, bob, sealed } = await sealedForBob(cache);

    expect(await bob.openCached(T, 'msg-1', sealed)).toBe('hello-bob');
    // Second read is served from the plaintext cache, NOT from MLS (whose key
    // is already gone). This is what makes a page reload safe.
    expect(await bob.openCached(T, 'msg-1', sealed)).toBe('hello-bob');
    expect(cache.map.get(`mls.msg.${T}.msg-1`)).toBe('hello-bob');
  });

  it('a sender can never MLS-open its OWN message — own text must come from local plaintext', async () => {
    const ds = new MemoryDS();
    const T = 'topic-own-message';
    const alice = new MlsSessionStore(ds, 'alice');
    const bob = new MlsSessionStore(ds, 'bob');

    const seed = await alice.seal(T, 'seed');
    await bob.open(T, seed);
    for (const c of await ds.getCommitsSince(T, 0)) await alice.applyCommit(T, c.commit);

    const mine = await alice.seal(T, 'my own words');
    // Alice's send ratchet has advanced past this message — she cannot read it
    // back. This is why ChatPanel resolves the SSE echo of a message it just
    // sent from `pendingSendsRef` (keyed by ciphertext) instead of decrypting.
    expect(await alice.open(T, mine)).toBeNull();
    // ...and it really is a valid message for everyone else.
    expect(await bob.open(T, mine)).toBe('my own words');
  });
});
