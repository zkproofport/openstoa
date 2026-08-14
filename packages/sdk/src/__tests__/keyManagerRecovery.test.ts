/**
 * A recovered device must still be able to read what it sealed BEFORE the
 * recovery — in Node, against the real file vault.
 *
 * Everything an agent keeps locally (MLS group state, cached plaintexts, TAK
 * keys) is sealed under HKDF(master_key). `EncryptingKVStore.get` reports a
 * value it cannot open as ABSENT rather than throwing, so swapping the master
 * key does not fail loudly — it makes the device silently forget its own group
 * state and archive keys. On the one device that still held the history,
 * recovery destroyed it. The web copy fixed this by retiring the outgoing key
 * and falling back to it on read; the SDK copy was 61 lines behind and had none
 * of it.
 *
 * Byte-identity with the web copy is asserted in `src/__tests__/
 * mlsCryptoTwins.test.ts`. That proves the SDK has the same SOURCE. It does not
 * prove the behaviour works on Node's webcrypto, and it does not prove the
 * CALLER engages it — which is exactly how the leaf-identity gap survived a
 * green twin test. These tests cover both.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → 'a value sealed under the old key is still readable'
 *   integrity  → 'the value is re-sealed under the LIVE key as it is read'
 *                (the migration is opportunistic — Keychain cannot enumerate,
 *                so reads are the only chance to move an item)
 *   boundary   → 'a device that never recovered has no retired key'
 *   empty/null → 'an unopenable value with no retired key reads as absent'
 *   hostile    → 'a WRONG retired key does not resurrect the value'
 *   external   → 'a root store that throws does not break reads' AND
 *                'a broken root store leaves no unobserved rejection' — the read
 *                surviving does not imply the process does
 *   authz/race/UTF-8/large → N/A: this is local at-rest sealing, no network,
 *                no authorization, and the payload is opaque bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileVaultStore } from '../keystore';
import { keyManager } from '../mls';
import type { SecureKVStore } from '../mls';

const { EncryptingKVStore, installMasterKey, loadOrCreateMasterKey, loadRetiredMasterKey } = keyManager;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openstoa-km-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The two stores a client builds: a root holding the key, and a sealed area. */
function stores() {
  const rootStore = createFileVaultStore({ root, namespace: undefined });
  const raw = createFileVaultStore({ root, namespace: 'topic-1' });
  return { rootStore, raw };
}

describe('a recovered agent can still read what it sealed before recovering', () => {
  it('CONTRACT: a value sealed under the OLD key is still readable after recovery', async () => {
    const { rootStore, raw } = stores();
    const original = await loadOrCreateMasterKey(rootStore);

    const before = EncryptingKVStore.lazy(raw, async () => original, rootStore);
    await before.set('mls.state.topic-1', 'the group state');

    // Recover onto a DIFFERENT key, the way the recovery flow does.
    const recovered = new Uint8Array(32).fill(7);
    await installMasterKey(rootStore, recovered);

    const after = EncryptingKVStore.lazy(raw, async () => recovered, rootStore);
    expect(
      await after.get('mls.state.topic-1'),
      'recovery silently destroyed the group state this device was holding',
    ).toBe('the group state');
  });

  it('INTEGRITY: the value is re-sealed under the LIVE key as it is read', async () => {
    /*
     * The migration has to happen on read, because a SecureKVStore has no list
     * operation (Keychain cannot enumerate) so nothing can walk the store and
     * convert it. Proven by dropping the retired key afterwards: if the value
     * had not been re-sealed, it would vanish again.
     */
    const { rootStore, raw } = stores();
    const original = await loadOrCreateMasterKey(rootStore);
    const before = EncryptingKVStore.lazy(raw, async () => original, rootStore);
    await before.set('tak.epoch.topic-1.3', 'epoch key');

    const recovered = new Uint8Array(32).fill(9);
    await installMasterKey(rootStore, recovered);
    const after = EncryptingKVStore.lazy(raw, async () => recovered, rootStore);
    expect(await after.get('tak.epoch.topic-1.3')).toBe('epoch key');

    // Now read with NO fallback at all. Only a re-sealed value survives.
    const liveOnly = EncryptingKVStore.lazy(raw, async () => recovered);
    expect(
      await liveOnly.get('tak.epoch.topic-1.3'),
      'the value was returned but never migrated — the next recovery loses it',
    ).toBe('epoch key');
  });

  it('BOUNDARY: a device that never recovered has no retired key', async () => {
    const { rootStore } = stores();
    await loadOrCreateMasterKey(rootStore);
    expect(await loadRetiredMasterKey(rootStore)).toBeNull();
  });

  it('EMPTY: an unopenable value with no retired key reads as ABSENT, not an error', async () => {
    // The behaviour that made the original bug silent. Pinned deliberately: it
    // is correct (a torn value must not crash a client) and it is the reason
    // the fallback has to exist.
    const { rootStore, raw } = stores();
    const original = await loadOrCreateMasterKey(rootStore);
    const before = EncryptingKVStore.lazy(raw, async () => original, rootStore);
    await before.set('k', 'v');

    const stranger = EncryptingKVStore.lazy(raw, async () => new Uint8Array(32).fill(1));
    expect(await stranger.get('k')).toBeNull();
  });

  it('HOSTILE: a WRONG retired key does not resurrect the value', async () => {
    /*
     * The fallback must be a decrypt that either works or does not — never a
     * guess. A retired key that did not seal this value has to fail closed.
     */
    const { rootStore, raw } = stores();
    const original = await loadOrCreateMasterKey(rootStore);
    const before = EncryptingKVStore.lazy(raw, async () => original, rootStore);
    await before.set('k', 'v');

    // Retire a key that never sealed anything here.
    await installMasterKey(rootStore, new Uint8Array(32).fill(3));
    await installMasterKey(rootStore, new Uint8Array(32).fill(4));

    const after = EncryptingKVStore.lazy(raw, async () => new Uint8Array(32).fill(4), rootStore);
    expect(await after.get('k')).toBeNull();
  });

  it('EXTERNAL FAILURE: a root store that throws does not break reads', async () => {
    // The fallback is an optimisation on top of a working read. A broken root
    // store must degrade to "no fallback", never to "no reads".
    const { raw } = stores();
    const key = new Uint8Array(32).fill(5);
    const live = EncryptingKVStore.lazy(raw, async () => key);
    await live.set('k', 'v');

    const brokenRoot: SecureKVStore = {
      get: async () => {
        throw new Error('keychain unavailable');
      },
      set: async () => {
        throw new Error('keychain unavailable');
      },
    };
    const withBrokenFallback = EncryptingKVStore.lazy(raw, async () => key, brokenRoot);
    await expect(withBrokenFallback.get('k')).resolves.toBe('v');
  });

  it('EXTERNAL FAILURE: a broken root store leaves no unobserved rejection', async () => {
    // Not the same claim as the test above. The read succeeding is only half of
    // it: the live key opens the value on the first try, so `get` returns before
    // it ever awaits the fallback promise. A rejection there is observed by
    // nobody, and Node terminates a process that has no unhandledRejection
    // handler installed — so "reads still work" and "the app survives" are two
    // different guarantees. Vitest installs a handler, which is why the suite
    // only reported this as an unhandled error instead of dying.
    const seen: unknown[] = [];
    const capture = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', capture);
    try {
      const { raw } = stores();
      const key = new Uint8Array(32).fill(6);
      await EncryptingKVStore.lazy(raw, async () => key).set('k', 'v');

      const brokenRoot: SecureKVStore = {
        get: async () => {
          throw new Error('keychain unavailable');
        },
        set: async () => {
          throw new Error('keychain unavailable');
        },
      };
      await expect(EncryptingKVStore.lazy(raw, async () => key, brokenRoot).get('k')).resolves.toBe('v');

      // Node reports an unhandled rejection on a later macrotask, not a microtask.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  });
});
