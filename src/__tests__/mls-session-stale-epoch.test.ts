/**
 * Stale-epoch seal regression (the "[unable to decrypt]" amplifier).
 *
 * seal() used to swallow catch-up failures and seal under the CURRENT (stale)
 * epoch. A member who joined at a later epoch can never decrypt such a message
 * — MLS forward secrecy makes it unrecoverable — so a transient transport blip
 * silently and permanently corrupted the conversation for late joiners.
 *
 * A send that cannot reach the latest epoch must FAIL, not produce garbage.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry } from '@/lib/mls/mlsSession';
import { MlsSessionStore as MobileStore } from '../../packages/mobile/src/crypto/mlsSession';
import { parseCommitFraming } from '@/lib/mls/framing';

const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

class MemoryDS implements MlsTransport {
  groups = new Map<string, { groupInfo: string; epoch: number }>();
  commits = new Map<string, CommitLogEntry[]>();
  failCatchUp = false;

  async getGroupInfo(t: string) {
    return this.groups.get(t)?.groupInfo ?? null;
  }
  async postGroupInfo(t: string, gi: string) {
    if (this.groups.has(t)) return false;
    this.groups.set(t, { groupInfo: gi, epoch: 0 });
    this.commits.set(t, []);
    return true;
  }
  async postCommit(t: string, commitB64: string, giB64: string) {
    const g = this.groups.get(t);
    if (!g) return { ok: false };
    const framing = parseCommitFraming(unb64(commitB64)); // real server-side parse
    if (framing.epoch !== g.epoch) return { ok: false };
    g.epoch = framing.epoch + 1;
    g.groupInfo = giB64;
    this.commits.get(t)!.push({ epoch: g.epoch, commit: commitB64, welcome: null });
    return { ok: true, epoch: g.epoch };
  }
  async getCommitsSince(t: string, since: number) {
    if (this.failCatchUp) throw new Error('transport failure');
    return (this.commits.get(t) ?? []).filter((c) => c.epoch > since);
  }
}

describe.each([
  ['web', MlsSessionStore],
  ['mobile', MobileStore as unknown as typeof MlsSessionStore],
])('%s MlsSessionStore.seal refuses to seal under a stale epoch', (_name, Store) => {
  it('rejects the send when catch-up fails instead of producing an undecryptable message', async () => {
    const ds = new MemoryDS();
    const T = 'stale-epoch-topic';
    const sender = new Store(ds, 'sender');
    const lateJoiner = new MlsSessionStore(ds, 'late-joiner');

    // Sender is genesis at epoch 0 and sends once.
    const first = await sender.seal(T, 'before-anyone-joined');
    expect(first.epoch).toBe(0);

    // Late joiner bootstraps via External Commit → group advances to epoch 1.
    // It cannot read the pre-join message (forward secrecy, by design).
    expect(await lateJoiner.open(T, first)).toBeNull();

    // Catch-up is down at send time. The send must fail loudly.
    ds.failCatchUp = true;
    await expect(sender.seal(T, 'must-not-be-sealed-at-epoch-0')).rejects.toThrow();

    // Once catch-up recovers, the send succeeds at the CURRENT epoch and the
    // late joiner can read it.
    ds.failCatchUp = false;
    const fresh = await sender.seal(T, 'after-recovery');
    expect(fresh.epoch).toBe(1);
    expect(await lateJoiner.open(T, fresh)).toBe('after-recovery');
  }, 30_000);
});
