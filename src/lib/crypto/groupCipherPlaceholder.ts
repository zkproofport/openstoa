/**
 * PLACEHOLDER GroupCipher for Phase 1 (ciphertext routing infra).
 *
 * ⚠️ NOT SECURE. This exists only to exercise the end-to-end ciphertext path —
 * client seals, server routes opaque bytes, client opens — before real MLS
 * lands in Phase 2. The per-topic key is derived deterministically from a
 * PUBLIC salt + the topicId, so anyone who knows the topicId can derive it.
 * It proves the wire format and the "server never sees plaintext" invariant,
 * nothing more. Phase 2 replaces this with MLS group secrets (epoch-keyed),
 * keeping the same `GroupCipher` shape so call sites are untouched.
 *
 * Runs on browser WebCrypto and Node's webcrypto (globalThis.crypto.subtle),
 * so the same module backs the web client and the E2E test. Types are declared
 * locally rather than imported from @openstoa/api-types because that package is
 * a dependency of the mobile package, not the Next.js web app.
 */

export interface SealedMessage {
  ciphertext: string; // base64-encoded sealed bytes
  epoch: number;
  takVersion?: number | null;
}

export interface GroupCipher {
  seal(topicId: string, plaintext: string): Promise<SealedMessage>;
  open(topicId: string, sealed: SealedMessage): Promise<string>;
}

const PLACEHOLDER_SALT = 'openstoa-phase1-placeholder/v1';
const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto subtle is unavailable in this runtime');
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveTopicKey(topicId: string): Promise<CryptoKey> {
  const material = await subtle().digest(
    'SHA-256',
    enc.encode(`${PLACEHOLDER_SALT}:${topicId}`) as BufferSource,
  );
  return subtle().importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export const placeholderGroupCipher: GroupCipher = {
  async seal(topicId: string, plaintext: string): Promise<SealedMessage> {
    const key = await deriveTopicKey(topicId);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      enc.encode(plaintext) as BufferSource,
    );
    // Prepend the IV so open() can recover it. [iv | ciphertext+tag]
    const ctBytes = new Uint8Array(ct);
    const framed = new Uint8Array(iv.length + ctBytes.length);
    framed.set(iv, 0);
    framed.set(ctBytes, iv.length);
    return { ciphertext: bytesToBase64(framed), epoch: 0 };
  },

  async open(topicId: string, sealed: SealedMessage): Promise<string> {
    const key = await deriveTopicKey(topicId);
    const framed = base64ToBytes(sealed.ciphertext);
    const iv = framed.subarray(0, IV_BYTES);
    const ct = framed.subarray(IV_BYTES);
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    return dec.decode(pt);
  },
};
