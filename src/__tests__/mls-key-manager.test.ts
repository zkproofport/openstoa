/**
 * Phase 4 key-management orchestration (keyManager.ts) + TakSessionStore keychain
 * snapshot (export/import). Proves the recovery plumbing the web + mobile wiring
 * depends on, all in-memory (fake store + fake HTTP), no container:
 *   - master_key lifecycle (create once / reuse / install-on-recovery / corrupt→regen)
 *   - EncryptingKVStore at-rest sealing (inner holds ciphertext; undecryptable→null)
 *   - TAK-keychain upload/restore round-trip (+ wrong key / missing → null)
 *   - master_key backup + recovery for both paths (recovery-code, multi-passkey)
 *   - TakSessionStore.exportKeychain/importKeychain round-trip + manifest + onChange
 */
import { describe, it, expect } from 'vitest';
import * as km from '@/lib/mls/keyManager';
import * as kb from '@/lib/mls/keyBackup';
import type { SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore } from '@/lib/mls/takSession';
import type { MlsSessionStore } from '@/lib/mls/mlsSession';

function memStore(): SecureKVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k)! : null),
    set: async (k, v) => void map.set(k, v),
  };
}

describe('master_key lifecycle', () => {
  it('creates a 32B key on first run and reuses it after', async () => {
    const root = memStore();
    const a = await km.loadOrCreateMasterKey(root);
    expect(a.length).toBe(32);
    const b = await km.loadOrCreateMasterKey(root);
    expect(kb.b64(b)).toBe(kb.b64(a)); // persisted, same key
    expect(await km.hasMasterKey(root)).toBe(true);
  });

  it('installMasterKey overwrites (recovery path)', async () => {
    const root = memStore();
    await km.loadOrCreateMasterKey(root);
    const recovered = kb.generateMasterKey();
    await km.installMasterKey(root, recovered);
    expect(kb.b64(await km.loadOrCreateMasterKey(root))).toBe(kb.b64(recovered));
  });

  it('regenerates a corrupt/short stored key rather than using it', async () => {
    const root = memStore();
    root.map.set('openstoa.masterKey.v1', kb.b64(new Uint8Array(8))); // too short
    const mk = await km.loadOrCreateMasterKey(root);
    expect(mk.length).toBe(32);
  });
});

describe('EncryptingKVStore (at-rest)', () => {
  it('stores ciphertext in the inner store and round-trips on get', async () => {
    const inner = memStore();
    const mk = kb.generateMasterKey();
    const enc = await km.EncryptingKVStore.create(inner, mk);

    await enc.set('mls.state.x', 'super-secret-state');
    // inner value is sealed, not the plaintext
    expect(inner.map.get('mls.state.x')).not.toBe('super-secret-state');
    expect(inner.map.get('mls.state.x')).toBeTruthy();
    expect(await enc.get('mls.state.x')).toBe('super-secret-state');
    expect(await enc.get('missing')).toBeNull();
  });

  it('reads undecryptable / wrong-key values as absent (safe re-bootstrap)', async () => {
    const inner = memStore();
    const enc1 = await km.EncryptingKVStore.create(inner, kb.generateMasterKey());
    await enc1.set('k', 'v');
    // a DIFFERENT master_key cannot read it → null (not a throw)
    const enc2 = await km.EncryptingKVStore.create(inner, kb.generateMasterKey());
    expect(await enc2.get('k')).toBeNull();
    // legacy plaintext (not sealed) also reads as absent
    inner.map.set('legacy', 'plain-text-value');
    expect(await enc1.get('legacy')).toBeNull();
  });
});

describe('TAK-keychain server backup', () => {
  it('uploads + restores a keychain snapshot (round-trip)', async () => {
    const mk = kb.generateMasterKey();
    const keychain = { 'tak.root.topicA': 'cm9vdA==', 'tak.epoch.topicB.3': 'ZXBvY2g=' };
    let stored: string | null = null;
    await km.uploadTakKeychain(mk, keychain, async (b64) => void (stored = b64));
    expect(stored).toBeTruthy();

    const restored = await km.restoreTakKeychain(mk, async () => stored);
    expect(restored).toEqual(keychain);
  });

  it('returns null on missing backup or wrong master_key', async () => {
    const mk = kb.generateMasterKey();
    expect(await km.restoreTakKeychain(mk, async () => null)).toBeNull();
    let stored: string | null = null;
    await km.uploadTakKeychain(mk, { a: 'YQ==' }, async (b) => void (stored = b));
    expect(await km.restoreTakKeychain(kb.generateMasterKey(), async () => stored)).toBeNull();
  });
});

describe('master_key backup + recovery', () => {
  it('recovery-code path: backup → recover; wrong code / missing → null', async () => {
    const mk = kb.generateMasterKey();
    let wrapped: string | null = null;
    const code = await km.backupWithRecoveryCode(mk, async (w) => void (wrapped = w));
    expect(kb.recoveryCodeEntropyBits(code)).toBeGreaterThanOrEqual(kb.RECOVERY_MIN_BITS);

    const fetchBackup = async (): Promise<km.KeyBackupState> => ({ wrappedMaster: wrapped, passkeys: [] });
    const recovered = await km.recoverWithRecoveryCode(code, fetchBackup);
    expect(recovered && kb.b64(recovered)).toBe(kb.b64(mk));
    expect(await km.recoverWithRecoveryCode(kb.generateRecoveryCode(), fetchBackup)).toBeNull();
    expect(await km.recoverWithRecoveryCode(code, async () => ({ wrappedMaster: null, passkeys: [] }))).toBeNull();
  });

  it('passkey path: multi-passkey backup → the matching PRF recovers', async () => {
    const mk = kb.generateMasterKey();
    const prf1 = kb.generateMasterKey();
    const prf2 = kb.generateMasterKey();
    const rows: Array<{ credentialId: string; prfWrapped: string }> = [];
    await km.backupWithPasskey(mk, 'cred-1', prf1, async (c, w) => void rows.push({ credentialId: c, prfWrapped: w }));
    await km.backupWithPasskey(mk, 'cred-2', prf2, async (c, w) => void rows.push({ credentialId: c, prfWrapped: w }));

    const fetchBackup = async (): Promise<km.KeyBackupState> => ({ wrappedMaster: null, passkeys: rows });
    expect(kb.b64((await km.recoverWithPasskey(prf1, fetchBackup))!)).toBe(kb.b64(mk));
    expect(kb.b64((await km.recoverWithPasskey(prf2, fetchBackup))!)).toBe(kb.b64(mk));
    expect(await km.recoverWithPasskey(kb.generateMasterKey(), fetchBackup)).toBeNull();
  });
});

describe('TakSessionStore keychain snapshot (export/import + manifest + onChange)', () => {
  // public archiveOnSend does not touch MLS state, so a null mls is safe here.
  const noMls = null as unknown as MlsSessionStore;
  // A transport that accepts the first fingerprint claim per topic, like the
  // server's compare-and-set — so archiveOnSend can mint a genesis root.
  function noopTransport() {
    const fingerprints = new Map<string, string>();
    return {
      postArchive: async () => {},
      getArchive: async () => [],
      postBundle: async () => {},
      getBundles: async () => [],
      ackBundles: async () => {},
      getRootFingerprint: async (t: string) => ({ fingerprint: fingerprints.get(t) ?? null, archiveCount: 0 }),
      setRootFingerprint: async (t: string, fingerprint: string) => {
        const cur = fingerprints.get(t);
        if (cur === undefined) {
          fingerprints.set(t, fingerprint);
          return { fingerprint, claimed: true };
        }
        return { fingerprint: cur, claimed: cur === fingerprint };
      },
    };
  }

  it('exports written TAK keys, fires onChange, and imports into a fresh store', async () => {
    const store = memStore();
    let changes = 0;
    const transport = noopTransport();
    const tak = new TakSessionStore(noMls, transport, store, () => void changes++);

    await tak.archiveOnSend('topicA', 'msg1', 'hello', 'public');
    await tak.archiveOnSend('topicA', 'msg2', 'world', 'public'); // same root, reused
    expect(changes).toBeGreaterThan(0);

    const keychain = await tak.exportKeychain();
    expect(Object.keys(keychain)).toContain('tak.root.topicA');
    expect(Object.keys(keychain)).not.toContain('tak.manifest'); // bookkeeping excluded

    // import into a fresh store → same snapshot round-trips
    const store2 = memStore();
    const tak2 = new TakSessionStore(noMls, transport, store2);
    await tak2.importKeychain(keychain);
    expect(await tak2.exportKeychain()).toEqual(keychain);
  });

  it('round-trips a keychain through an EncryptingKVStore-wrapped store', async () => {
    const mk = kb.generateMasterKey();
    const inner = memStore();
    const enc = await km.EncryptingKVStore.create(inner, mk);
    const tak = new TakSessionStore(noMls, noopTransport(), enc);

    await tak.archiveOnSend('topicE', 'm1', 'secret', 'public');
    const keychain = await tak.exportKeychain();
    // the raw inner store holds only ciphertext for the root key
    const innerRootVal = inner.map.get('tak.root.topicE');
    expect(innerRootVal).toBeTruthy();
    expect(innerRootVal).not.toBe(keychain['tak.root.topicE']);

    // upload (seal under tak-backup key) + restore + import into a fresh device
    let blob: string | null = null;
    await km.uploadTakKeychain(mk, keychain, async (b) => void (blob = b));
    const restored = await km.restoreTakKeychain(mk, async () => blob);
    expect(restored).toEqual(keychain);
  });
});
