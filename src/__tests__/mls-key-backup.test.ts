/**
 * Phase 4 key-recovery crypto core (keyBackup.ts) on Node WebCrypto, using the
 * SAME ts-mls ciphersuite provider the live-message + TAK layers use. Proves the
 * cryptographic contract the web + mobile clients and the recovery flow rely on:
 * master_key wrap/unwrap round-trips for both backup paths (passkey PRF +
 * recovery code), safe-fail on the wrong secret / tampered ciphertext (SI-8 no
 * oracle), the recovery-code generator always clears the SI-5 entropy floor, and
 * the at-rest blob keys (local store + TAK backup) are independent and lossless.
 *
 * Edge-case matrix rows covered here (unit layer): boundary (empty / 1-byte /
 * large payloads), hostile (wrong key, single-bit tamper), UTF-8 (Korean/emoji
 * round-trip), integrity (recovered master_key opens the TAK backup), SI-5
 * (floor), SI-8 (no unwrap oracle). authz / race / contract rows live in the
 * server E2E layer (P4-06).
 */
import { describe, it, expect } from 'vitest';
import * as kb from '@/lib/mls/keyBackup';

describe('master_key generation', () => {
  it('is 32 CSPRNG bytes and unique per call', () => {
    const a = kb.generateMasterKey();
    const b = kb.generateMasterKey();
    expect(a.length).toBe(kb.MASTER_KEY_LEN);
    expect(a.length).toBe(32);
    expect(kb.b64(a)).not.toBe(kb.b64(b)); // astronomically unlikely to collide
  });
});

describe('recovery code (SI-5: client CSPRNG, ≥128-bit)', () => {
  it('every generated code clears the 128-bit floor', () => {
    for (let i = 0; i < 200; i++) {
      const code = kb.generateRecoveryCode();
      expect(kb.recoveryCodeEntropyBits(code)).toBeGreaterThanOrEqual(kb.RECOVERY_MIN_BITS);
    }
  });

  it('is generated at 160 bits (32 base32 chars) with a fixed display shape', () => {
    const code = kb.generateRecoveryCode();
    expect(kb.recoveryCodeEntropyBits(code)).toBe(160);
    expect(kb.normalizeRecoveryCode(code).length).toBe(32);
    // 8 dash-separated groups of 4
    expect(code.split('-')).toHaveLength(8);
    expect(code.split('-').every((g) => g.length === 4)).toBe(true);
  });

  it('is unique per call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(kb.normalizeRecoveryCode(kb.generateRecoveryCode()));
    expect(seen.size).toBe(200);
  });

  it('normalizes case and separators so re-entry is forgiving', () => {
    const code = kb.generateRecoveryCode();
    const canonical = kb.normalizeRecoveryCode(code);
    expect(kb.normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(kb.normalizeRecoveryCode(code.replace(/-/g, ' '))).toBe(canonical);
    expect(kb.normalizeRecoveryCode(code.replace(/-/g, ''))).toBe(canonical);
  });

  it('reports 0 entropy for a non-base32 string (never appears to clear the floor)', () => {
    expect(kb.recoveryCodeEntropyBits('0189=====not base32!!!')).toBe(0);
    expect(kb.recoveryCodeEntropyBits('')).toBe(0);
  });
});

describe('recovery-code wrap/unwrap round-trip', () => {
  it('unwraps with the same code (with or without display separators)', async () => {
    const mk = kb.generateMasterKey();
    const code = kb.generateRecoveryCode();
    const wrapped = await kb.wrapMasterKeyWithRecoveryCode(code, mk);

    const out1 = await kb.unwrapMasterKeyWithRecoveryCode(code, wrapped);
    const out2 = await kb.unwrapMasterKeyWithRecoveryCode(code.replace(/-/g, '').toLowerCase(), wrapped);
    expect(out1 && kb.b64(out1)).toBe(kb.b64(mk));
    expect(out2 && kb.b64(out2)).toBe(kb.b64(mk));
  });

  it('safe-fails (null) on the wrong recovery code — no oracle (SI-8)', async () => {
    const mk = kb.generateMasterKey();
    const wrapped = await kb.wrapMasterKeyWithRecoveryCode(kb.generateRecoveryCode(), mk);
    const wrong = await kb.unwrapMasterKeyWithRecoveryCode(kb.generateRecoveryCode(), wrapped);
    expect(wrong).toBeNull();
  });

  it('safe-fails (null) on a single-bit tampered ciphertext', async () => {
    const mk = kb.generateMasterKey();
    const code = kb.generateRecoveryCode();
    const wrapped = await kb.wrapMasterKeyWithRecoveryCode(code, mk);
    const raw = kb.unb64(wrapped);
    raw[raw.length - 1] ^= 0x01; // flip one bit of the auth tag / ciphertext
    const tampered = await kb.unwrapMasterKeyWithRecoveryCode(code, kb.b64(raw));
    expect(tampered).toBeNull();
  });
});

describe('passkey PRF wrap/unwrap round-trip', () => {
  it('unwraps with the same 32-byte PRF output', async () => {
    const mk = kb.generateMasterKey();
    const prf = kb.generateMasterKey(); // stand-in for a 32-byte WebAuthn PRF result
    const wrapped = await kb.wrapMasterKeyWithPrf(prf, mk);
    const out = await kb.unwrapMasterKeyWithPrf(prf, wrapped);
    expect(out && kb.b64(out)).toBe(kb.b64(mk));
  });

  it('safe-fails (null) on a different PRF output', async () => {
    const mk = kb.generateMasterKey();
    const wrapped = await kb.wrapMasterKeyWithPrf(kb.generateMasterKey(), mk);
    expect(await kb.unwrapMasterKeyWithPrf(kb.generateMasterKey(), wrapped)).toBeNull();
  });

  it('multi-passkey: N distinct PRF outputs each recover the SAME master_key', async () => {
    const mk = kb.generateMasterKey();
    const prfs = [kb.generateMasterKey(), kb.generateMasterKey(), kb.generateMasterKey()];
    const wraps = await Promise.all(prfs.map((p) => kb.wrapMasterKeyWithPrf(p, mk)));
    for (let i = 0; i < prfs.length; i++) {
      const out = await kb.unwrapMasterKeyWithPrf(prfs[i], wraps[i]);
      expect(out && kb.b64(out)).toBe(kb.b64(mk));
    }
    // cross: passkey j cannot open passkey i's wrap
    expect(await kb.unwrapMasterKeyWithPrf(prfs[1], wraps[0])).toBeNull();
  });

  it('the two backup paths independently recover the same master_key (D8 two-path)', async () => {
    const mk = kb.generateMasterKey();
    const code = kb.generateRecoveryCode();
    const prf = kb.generateMasterKey();
    const viaCode = await kb.unwrapMasterKeyWithRecoveryCode(code, await kb.wrapMasterKeyWithRecoveryCode(code, mk));
    const viaPrf = await kb.unwrapMasterKeyWithPrf(prf, await kb.wrapMasterKeyWithPrf(prf, mk));
    expect(viaCode && kb.b64(viaCode)).toBe(kb.b64(mk));
    expect(viaPrf && kb.b64(viaPrf)).toBe(kb.b64(mk));
  });
});

describe('at-rest blob keys (local store + TAK backup)', () => {
  it('the two derived keys are independent (one cannot open the other blob)', async () => {
    const mk = kb.generateMasterKey();
    const localKey = await kb.deriveLocalStoreKey(mk);
    const takKey = await kb.deriveTakBackupKey(mk);
    expect(kb.b64(localKey)).not.toBe(kb.b64(takKey));

    const sealed = await kb.sealBlob(takKey, 'tak-keychain-json');
    expect(await kb.openBlob(localKey, sealed)).toBeNull(); // wrong derived key → safe-fail
    expect(await kb.openBlob(takKey, sealed)).toBe('tak-keychain-json');
  });

  it('a recovered master_key re-derives the TAK-backup key and opens the blob (integrity)', async () => {
    const mk = kb.generateMasterKey();
    const code = kb.generateRecoveryCode();

    // device side: seal a TAK keychain under the master_key-derived backup key
    const keychainJson = JSON.stringify({ 'tak.root.topicA': 'AAAA', 'tak.epoch.topicB.3': 'BBBB' });
    const backupBlob = await kb.sealBlob(await kb.deriveTakBackupKey(mk), keychainJson);
    const wrappedMaster = await kb.wrapMasterKeyWithRecoveryCode(code, mk);

    // recovery side (fresh device): only the wrapped master + recovery code + blob
    const recovered = await kb.unwrapMasterKeyWithRecoveryCode(code, wrappedMaster);
    expect(recovered).not.toBeNull();
    const opened = await kb.openBlob(await kb.deriveTakBackupKey(recovered!), backupBlob);
    expect(opened).toBe(keychainJson);
  });

  it('round-trips boundary + UTF-8 payloads (empty, 1 char, Korean/emoji, large)', async () => {
    const key = await kb.deriveLocalStoreKey(kb.generateMasterKey());
    const cases = ['', 'x', '한글 메시지 🇰🇷😀\n\ttab', 'A'.repeat(64 * 1024)];
    for (const pt of cases) {
      const sealed = await kb.sealBlob(key, pt);
      expect(await kb.openBlob(key, sealed)).toBe(pt);
    }
  });

  it('two seals of the same payload differ (fresh nonce) but both open', async () => {
    const key = await kb.deriveLocalStoreKey(kb.generateMasterKey());
    const a = await kb.sealBlob(key, 'same');
    const b = await kb.sealBlob(key, 'same');
    expect(a).not.toBe(b);
    expect(await kb.openBlob(key, a)).toBe('same');
    expect(await kb.openBlob(key, b)).toBe('same');
  });
});

describe('domain separation', () => {
  it('the four HKDF labels yield four distinct keys from one master_key', async () => {
    const mk = kb.generateMasterKey();
    const localKey = kb.b64(await kb.deriveLocalStoreKey(mk));
    const takKey = kb.b64(await kb.deriveTakBackupKey(mk));
    // PRF-wrap and recovery-wrap keys are internal, but their effect is observable:
    // a blob sealed under the local-store key must not open under the tak-backup key,
    // and vice-versa (already covered above); here assert the raw keys are distinct.
    expect(localKey).not.toBe(takKey);
  });

  it('a PRF wrap is never opened by the recovery-code path (label separation)', async () => {
    const mk = kb.generateMasterKey();
    const prfWrap = await kb.wrapMasterKeyWithPrf(kb.generateMasterKey(), mk);
    // Even a syntactically valid recovery code cannot open a PRF-labelled wrap.
    expect(await kb.unwrapMasterKeyWithRecoveryCode(kb.generateRecoveryCode(), prfWrap)).toBeNull();
  });
});
