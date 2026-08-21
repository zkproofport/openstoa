/**
 * Portable key-recovery crypto core for Phase 4 (design §6.1/§6.4, SI-5/SI-8).
 *
 * A per-user `master_key` (random 32B, generated on the device, never seen by
 * the server in the clear) is the root that:
 *   - encrypts the device's local secure store  (deriveLocalStoreKey)
 *   - encrypts the TAK-keychain blob backed up to the server (deriveTakBackupKey),
 *     so a recovered master_key alone re-reads all archived history without any
 *     other member being online (design §6.4.1 total-device-loss recovery).
 *
 * master_key itself is backed up to the server two ways — both "no escrow": the
 * server stores only the wrapped ciphertext and holds neither unwrap secret.
 *   - passkey PRF  : prf_wrapped    = AEAD(HKDF(WebAuthn PRF output), master_key)
 *   - recovery code: wrapped_master = AEAD(HKDF(recovery_code),      master_key)
 *
 * SI-5: the recovery code is client-CSPRNG, base32, ≥128-bit — generated here so
 * the floor is guaranteed by construction (never a user-chosen passphrase).
 * SI-8: unwrap always safe-fails to null (no oracle) and the server never runs
 * this module, so a DB dump yields only ciphertext.
 *
 * This is the portable core (no storage, no HTTP). The web client and node tests
 * use it directly; the mobile mini-app keeps a byte-identical copy at
 * packages/mobile/src/crypto/keyBackup.ts (same suite provider) — keep in sync.
 */
import * as gc from './groupClient';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const MASTER_KEY_LEN = 32;
const WRAP_KEY_LEN = 16; // AES-128-GCM key (suite 0x0001) — matches the AEAD provider

// Recovery code: RFC 4648 base32 (no padding), 20 random bytes = 160 bits,
// comfortably above the SI-5 128-bit floor. 160 is a multiple of 5 so it encodes
// to exactly 32 chars with no partial/padding character.
const RECOVERY_CODE_BYTES = 20;
export const RECOVERY_MIN_BITS = 128; // SI-5 floor
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Domain-separation labels for every HKDF-derived key. Distinct labels ensure the
// PRF-wrap key, recovery-wrap key, local-store key, and tak-backup key are
// independent even if two inputs ever collided.
const LABEL_PRF = 'openstoa-prf-wrap/v1';
const LABEL_RECOVERY = 'openstoa-recovery-wrap/v1';
const LABEL_LOCAL_STORE = 'openstoa-local-store/v1';
const LABEL_TAK_BACKUP = 'openstoa-tak-backup/v1';

export function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u); // browser, node, and the RN polyfill
  return u;
}

// ---------------------------------------------------------------------------
// master_key
// ---------------------------------------------------------------------------

/** Fresh per-user root key. CSPRNG 32 bytes; device-only, never sent in clear. */
export function generateMasterKey(): Uint8Array {
  return randomBytes(MASTER_KEY_LEN);
}

// ---------------------------------------------------------------------------
// recovery code (SI-5: client CSPRNG, ≥128-bit, never user-chosen)
// ---------------------------------------------------------------------------

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Generate a recovery code: 160-bit CSPRNG value in RFC-4648 base32, shown in
 * 8 groups of 4 for legibility (e.g. `A2CD-EF34-...`). The display separators are
 * cosmetic — normalizeRecoveryCode strips them before key derivation, so the user
 * may re-enter it with or without dashes/spaces/case.
 */
export function generateRecoveryCode(): string {
  const code = base32Encode(randomBytes(RECOVERY_CODE_BYTES)); // 32 chars
  return code.match(/.{1,4}/g)!.join('-');
}

/** Canonical form used for key derivation: strip separators, upper-case. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Entropy (bits) of a recovery code as generated: each valid base32 char carries
 * 5 bits. Returns 0 if any character is outside the base32 alphabet (so a garbage
 * string never appears to clear the floor). Used to prove SI-5 in unit tests.
 */
export function recoveryCodeEntropyBits(code: string): number {
  const norm = normalizeRecoveryCode(code);
  for (const c of norm) if (!BASE32_ALPHABET.includes(c)) return 0;
  return norm.length * 5;
}

// ---------------------------------------------------------------------------
// HKDF + AEAD primitives (via the shared MLS ciphersuite provider — subtle on
// web, noble on mobile — so key wrapping matches the live-message crypto path)
// ---------------------------------------------------------------------------

async function hkdf(secret: Uint8Array, label: string, len: number): Promise<Uint8Array> {
  const cs = await gc.ciphersuiteImpl();
  // The provider's extract requires a hash-length salt; use a zero salt and bind
  // the domain-separation label in the expand info (same convention as takClient).
  const salt = new Uint8Array(cs.kdf.size);
  const prk = await cs.kdf.extract(salt, secret);
  return cs.kdf.expand(prk, enc.encode(label), len);
}

async function aeadSeal(key: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const cs = await gc.ciphersuiteImpl();
  const nonce = randomBytes(cs.hpke.nonceLength);
  const ct = await cs.hpke.encryptAead(key, nonce, undefined, plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return b64(out);
}

/** Safe-fail: a wrong key or tampered ciphertext returns null (no oracle, SI-8). */
async function aeadOpen(key: Uint8Array, sealedB64: string): Promise<Uint8Array | null> {
  try {
    const cs = await gc.ciphersuiteImpl();
    const raw = unb64(sealedB64);
    const nonce = raw.slice(0, cs.hpke.nonceLength);
    const ct = raw.slice(cs.hpke.nonceLength);
    return await cs.hpke.decryptAead(key, nonce, undefined, ct);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// master_key wrapping — the two "no escrow" server-side backup paths
// ---------------------------------------------------------------------------

export async function wrapMasterKeyWithRecoveryCode(code: string, masterKey: Uint8Array): Promise<string> {
  const wk = await hkdf(enc.encode(normalizeRecoveryCode(code)), LABEL_RECOVERY, WRAP_KEY_LEN);
  return aeadSeal(wk, masterKey);
}
export function unwrapMasterKeyWithRecoveryCode(code: string, wrappedB64: string): Promise<Uint8Array | null> {
  return hkdf(enc.encode(normalizeRecoveryCode(code)), LABEL_RECOVERY, WRAP_KEY_LEN).then((wk) => aeadOpen(wk, wrappedB64));
}

/** `prfOutput` is the 32-byte WebAuthn PRF/hmac-secret result (design §6.2). */
export async function wrapMasterKeyWithPrf(prfOutput: Uint8Array, masterKey: Uint8Array): Promise<string> {
  const wk = await hkdf(prfOutput, LABEL_PRF, WRAP_KEY_LEN);
  return aeadSeal(wk, masterKey);
}
export function unwrapMasterKeyWithPrf(prfOutput: Uint8Array, wrappedB64: string): Promise<Uint8Array | null> {
  return hkdf(prfOutput, LABEL_PRF, WRAP_KEY_LEN).then((wk) => aeadOpen(wk, wrappedB64));
}

// ---------------------------------------------------------------------------
// master_key → at-rest encryption keys (local store + server TAK-keychain blob)
// ---------------------------------------------------------------------------

/** AEAD key for the device's local secure store (values encrypted at rest). */
export function deriveLocalStoreKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return hkdf(masterKey, LABEL_LOCAL_STORE, WRAP_KEY_LEN);
}
/** AEAD key for the TAK-keychain blob uploaded to the server (history recovery). */
export function deriveTakBackupKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return hkdf(masterKey, LABEL_TAK_BACKUP, WRAP_KEY_LEN);
}

/** Seal a UTF-8 string payload under a derived key → base64(nonce‖ct). */
export function sealBlob(key: Uint8Array, plaintext: string): Promise<string> {
  return aeadSeal(key, enc.encode(plaintext));
}
/** Open a sealBlob payload; null on wrong key / tamper. */
export async function openBlob(key: Uint8Array, sealedB64: string): Promise<string | null> {
  const pt = await aeadOpen(key, sealedB64);
  return pt == null ? null : dec.decode(pt);
}
