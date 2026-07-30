/**
 * open() must FAIL SOFT — the blast-radius regression.
 *
 * `open()` acquired the session OUTSIDE its try/catch, so a bootstrap/rejoin
 * failure (DS unreachable, unreadable key store) REJECTED instead of returning
 * null. Every UI caller maps open/openCached over a whole history page through
 * `Promise.all`, so one such rejection discarded every sibling row and blanked
 * the message list. `open()`'s own docstring already promised `string | null`.
 *
 * Asymmetry pinned here on purpose: open() fails soft, seal() still fails HARD.
 * Nothing is persisted on the open path and the next load retries, whereas a
 * soft seal would silently seal under a stale epoch — permanently undecryptable
 * for every later joiner (see mls-session-stale-epoch.test.ts).
 *
 * Runs against all THREE cores (web / mobile / sdk) because they are meant to
 * carry identical logic; a fix applied to only one would fail here.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore, type MlsTransport, type CommitLogEntry, type SecureKVStore } from '@/lib/mls/mlsSession';
import { MlsSessionStore as MobileStore } from '../../packages/mobile/src/crypto/mlsSession';
import { MlsSessionStore as SdkStore } from '../../packages/sdk/src/mls/mlsSession';

/** A DS that can be made to fail the bootstrap handshake on demand. */
class BrokenDS implements MlsTransport {
  failGroupInfo = true;
  async getGroupInfo(_t: string): Promise<string | null> {
    if (this.failGroupInfo) throw new Error('DS unreachable');
    return null;
  }
  async postGroupInfo() {
    return true;
  }
  async postCommit() {
    return { ok: true, epoch: 1 };
  }
  async getCommitsSince(): Promise<CommitLogEntry[]> {
    return [];
  }
}

const SEALED = { ciphertext: 'c2VhbGVkLWJ5dGVz', epoch: 0 };

describe.each([
  ['web', MlsSessionStore],
  ['mobile', MobileStore as unknown as typeof MlsSessionStore],
  ['sdk', SdkStore as unknown as typeof MlsSessionStore],
])('%s MlsSessionStore.open — soft failure', (_name, Store) => {
  it('returns null (never rejects) when the session cannot be bootstrapped', async () => {
    const store = new Store(new BrokenDS(), 'device-1');
    await expect(store.open('t-1', SEALED)).resolves.toBeNull();
  });

  it('openCached also returns null instead of propagating the bootstrap failure', async () => {
    const store = new Store(new BrokenDS(), 'device-2');
    await expect(store.openCached('t-1', 'm-1', SEALED)).resolves.toBeNull();
  });

  it('a page of rows all resolve — one bad session cannot reject Promise.all', async () => {
    const store = new Store(new BrokenDS(), 'device-3');
    const rows = ['m-1', 'm-2', 'm-3'];
    const out = await Promise.all(rows.map((id) => store.openCached('t-1', id, SEALED)));
    expect(out).toEqual([null, null, null]);
  });

  it('an unreadable key store degrades to null rather than rejecting', async () => {
    const badStore: SecureKVStore = {
      get: async () => {
        throw new Error('keychain unavailable');
      },
      set: async () => {},
    };
    const store = new Store(new BrokenDS(), 'device-4', badStore);
    await expect(store.open('t-1', SEALED)).resolves.toBeNull();
  });

  it('a failing message cache never poisons the result either', async () => {
    const badCache: SecureKVStore = {
      get: async () => {
        throw new Error('cache unreadable');
      },
      set: async () => {
        throw new Error('cache unwritable');
      },
    };
    const store = new Store(new BrokenDS(), 'device-5', undefined, badCache);
    await expect(store.openCached('t-1', 'm-1', SEALED)).resolves.toBeNull();
  });

  it('CONTRAST: seal() still REJECTS on the same failure (stale-epoch data loss)', async () => {
    const store = new Store(new BrokenDS(), 'device-6');
    await expect(store.seal('t-1', 'hello')).rejects.toThrow();
  });
});
