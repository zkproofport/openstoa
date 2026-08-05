import { describe, it, expect } from 'vitest';
import * as km from '@/lib/mls/keyManager';
import * as kb from '@/lib/mls/keyBackup';
import type { SecureKVStore } from '@/lib/mls/mlsSession';

/**
 * Recovery must not destroy the history of the device that runs it.
 *
 * Everything local — MLS group state, cached plaintexts, TAK keys — is sealed
 * under HKDF(master_key). Installing a recovered key therefore made every
 * existing value fail to open, and `EncryptingKVStore.get` reports an unopenable
 * value as ABSENT. So pressing Recover on the one device that still held the
 * conversation silently emptied it, with no error and nothing to undo.
 */
function memStore(): SecureKVStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, get: async (k) => raw.get(k) ?? null, set: async (k, v) => void raw.set(k, v) };
}

describe('master_key rotation on recovery', () => {
  it('REGRESSION: data written before recovery is still readable after it', async () => {
    const root = memStore();
    const original = await km.loadOrCreateMasterKey(root);
    const before = km.EncryptingKVStore.lazy(root, async () => original, root);
    await before.set('mls.state.t1', 'the-group-state');

    // The account's real key arrives from the backup and replaces the local one.
    const recovered = kb.generateMasterKey();
    await km.installMasterKey(root, recovered);

    const after = km.EncryptingKVStore.lazy(root, async () => recovered, root);
    expect(await after.get('mls.state.t1')).toBe('the-group-state');
  });

  it('MIGRATES on read, so the value survives the NEXT rotation too', async () => {
    const root = memStore();
    const first = await km.loadOrCreateMasterKey(root);
    await km.EncryptingKVStore.lazy(root, async () => first, root).set('tak.root.t1', 'AAA');

    const second = kb.generateMasterKey();
    await km.installMasterKey(root, second);
    const afterFirst = km.EncryptingKVStore.lazy(root, async () => second, root);
    expect(await afterFirst.get('tak.root.t1')).toBe('AAA'); // re-sealed under `second`

    // Only ONE retired key is kept, so a value that had not been read by now
    // would be lost here — the read above is what saves it.
    const third = kb.generateMasterKey();
    await km.installMasterKey(root, third);
    const afterSecond = km.EncryptingKVStore.lazy(root, async () => third, root);
    expect(await afterSecond.get('tak.root.t1')).toBe('AAA');
  });

  it('a genuinely absent key is still absent — the fallback invents nothing', async () => {
    const root = memStore();
    const original = await km.loadOrCreateMasterKey(root);
    await km.installMasterKey(root, kb.generateMasterKey());
    const store = km.EncryptingKVStore.lazy(root, async () => original, root);
    expect(await store.get('never.written')).toBeNull();
  });

  it('installing the SAME key twice does not retire it over itself', async () => {
    const root = memStore();
    const mk = await km.loadOrCreateMasterKey(root);
    await km.installMasterKey(root, mk);
    // Retiring the live key would leave the fallback pointing at the current key
    // and quietly discard the real predecessor on the next rotation.
    expect(await km.loadRetiredMasterKey(root)).toBeNull();
  });

  it('without a root store there is no fallback — opt-in, never implicit', async () => {
    const root = memStore();
    const original = await km.loadOrCreateMasterKey(root);
    await km.EncryptingKVStore.lazy(root, async () => original, root).set('k', 'v');

    const recovered = kb.generateMasterKey();
    await km.installMasterKey(root, recovered);

    const noFallback = km.EncryptingKVStore.lazy(root, async () => recovered);
    expect(await noFallback.get('k')).toBeNull();
  });

  it('the retired key is the PREVIOUS one, not an accumulating chain', async () => {
    const root = memStore();
    const first = await km.loadOrCreateMasterKey(root);
    const second = kb.generateMasterKey();
    await km.installMasterKey(root, second);
    const third = kb.generateMasterKey();
    await km.installMasterKey(root, third);

    const retired = await km.loadRetiredMasterKey(root);
    expect(retired && kb.b64(retired)).toBe(kb.b64(second));
    expect(retired && kb.b64(retired)).not.toBe(kb.b64(first));
  });
});
