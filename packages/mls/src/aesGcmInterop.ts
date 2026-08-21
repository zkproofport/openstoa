/**
 * AES-GCM interop shim — for hosts whose `crypto.subtle` is not spec-exact.
 *
 * Lives in the SHARED package, not in a mobile copy of the client, because the
 * bug it fixes is a wire-compatibility bug between the two clients: the fix has
 * to be described in the same place as the code it protects, or the next port
 * loses it. It is INERT on a spec-correct WebCrypto (byte-identical output), so
 * shipping it everywhere would be safe; it is opt-in only because there is no
 * reason to pay for it where it does nothing.
 *
 * Install it via `configureMlsRuntime({ prepareCrypto: installNobleAesGcmInterop })`.
 */
// On Hermes `crypto.subtle` is react-native-quick-crypto, whose AES-GCM
// *encrypt* produces ciphertext that standard WebCrypto (the web client) cannot
// decrypt — mobile→web breaks while web→mobile keeps working, because
// quick-crypto's *decrypt* accepts standard ciphertext.
//
// ts-mls's `nobleCryptoProvider` only replaces the MLS application-message
// AEAD. HPKE — Commit UpdatePath secrets, Welcome, and every TAK archive/key
// bundle (takClient `cs.hpke.seal`) — is built by ts-mls on `@hpke/core`'s
// `Aes128Gcm`, which calls `crypto.subtle` directly and is unreachable through
// ts-mls's public API. So a mobile-produced External Commit still carried a
// quick-crypto-sealed path secret that other members could not HPKE-open:
// their `processCommit` threw → `catchUp` threw → every later mobile message
// rendered as "[unable to decrypt]" for them.
//
// Fix: serve raw AES-GCM keys from `@noble/ciphers` (pure JS, spec-exact:
// 16-byte tag appended, `additionalData` honoured) instead of the host's
// WebCrypto, so NO AES-GCM operation in the mini-app depends on it. Everything
// else (HKDF, X25519, Ed25519, SHA-2 — all proven on-device) falls through
// untouched. On a spec-correct WebCrypto this is byte-identical, so it is inert
// on web/node and safe for any other host consumer of subtle AES-GCM.
const NOBLE_AES_KEY = '__openstoaNobleAesGcmKey';
let _aesShimInstalled = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function algNameOf(a: any): string {
  return (typeof a === 'string' ? a : a?.name) ?? '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asBytes(d: any): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export function installNobleAesGcmInterop(): void {
  if (_aesShimInstalled) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle: any = (globalThis as any).crypto?.subtle;
  if (!subtle) return; // no WebCrypto yet — ts-mls would fail anyway; leave as-is
  _aesShimInstalled = true;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { gcm } = require('@noble/ciphers/aes.js');

  const nativeImportKey = subtle.importKey.bind(subtle);
  const nativeEncrypt = subtle.encrypt.bind(subtle);
  const nativeDecrypt = subtle.decrypt.bind(subtle);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeyOf = (key: any): Uint8Array | null =>
    key && typeof key === 'object' && key[NOBLE_AES_KEY] instanceof Uint8Array ? key[NOBLE_AES_KEY] : null;

  // Only `raw` AES-GCM keys are intercepted; the marker object carries the key
  // bytes so encrypt/decrypt can run them through noble. WebCrypto CryptoKeys
  // are imported non-extractable, so the bytes are otherwise unrecoverable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.importKey = async (format: string, keyData: any, algorithm: any, extractable: boolean, usages: string[]) => {
    if (format === 'raw' && algNameOf(algorithm) === 'AES-GCM') {
      return {
        type: 'secret',
        extractable,
        usages,
        algorithm: { name: 'AES-GCM', length: asBytes(keyData).length * 8 },
        [NOBLE_AES_KEY]: new Uint8Array(asBytes(keyData)),
      };
    }
    return nativeImportKey(format, keyData, algorithm, extractable, usages);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nobleParams = (algorithm: any, raw: Uint8Array) => {
    // tagLength defaults to 128 in WebCrypto, which is what noble produces.
    if (algorithm.tagLength !== undefined && algorithm.tagLength !== 128) return null;
    const aad = algorithm.additionalData ? asBytes(algorithm.additionalData) : undefined;
    return gcm(raw, asBytes(algorithm.iv), aad && aad.length > 0 ? aad : undefined);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.encrypt = async (algorithm: any, key: any, data: any) => {
    const raw = rawKeyOf(key);
    if (raw && algNameOf(algorithm) === 'AES-GCM') {
      const cipher = nobleParams(algorithm, raw);
      if (cipher) return toArrayBuffer(cipher.encrypt(asBytes(data)));
    }
    return nativeEncrypt(algorithm, key, data);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtle.decrypt = async (algorithm: any, key: any, data: any) => {
    const raw = rawKeyOf(key);
    if (raw && algNameOf(algorithm) === 'AES-GCM') {
      const cipher = nobleParams(algorithm, raw);
      if (cipher) return toArrayBuffer(cipher.decrypt(asBytes(data)));
    }
    return nativeDecrypt(algorithm, key, data);
  };
}

/** Test hook: true once the AES-GCM interop shim is active. */
export function aesGcmInteropInstalled(): boolean {
  return _aesShimInstalled;
}
