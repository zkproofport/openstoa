import type { ChatMessage, GroupCipher, SealedMessage } from '@openstoa/api-types';

/**
 * PLACEHOLDER GroupCipher for Phase 1 (mobile mini-app side).
 *
 * ⚠️ NOT SECURE — mirrors the web placeholder
 * (openstoa/src/lib/crypto/groupCipherPlaceholder.ts) byte-for-byte so a
 * message sealed on web opens on mobile and vice versa. The per-topic key is
 * derived from a PUBLIC salt + topicId purely to exercise the ciphertext path
 * before MLS lands in Phase 2 (which replaces this with epoch-keyed MLS group
 * secrets behind the same GroupCipher interface).
 *
 * RUNTIME REQUIREMENT: globalThis.crypto.subtle must be present. In the
 * ZKProofport host this comes from react-native-quick-crypto (Phase 0). The
 * host must install the WebCrypto polyfill at app boot for chat to decrypt —
 * tracked as a Phase 1 mobile-integration follow-up.
 */

const PLACEHOLDER_SALT = 'openstoa-phase1-placeholder/v1';
const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto subtle unavailable — host must install the polyfill');
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

/**
 * Decrypt a server chat row for display. User rows carry an encrypted `sealed`
 * body; we decrypt it into `message` so the renderer keeps using `item.message`.
 * System rows (join/leave) pass through unchanged. Decryption failures fail
 * soft to a placeholder string rather than dropping the row.
 */
export async function toDisplayMessage(topicId: string, raw: ChatMessage): Promise<ChatMessage> {
  if (raw?.type === 'message') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      try {
        text = await placeholderGroupCipher.open(topicId, raw.sealed);
      } catch {
        text = '[unable to decrypt]';
      }
    }
    return { ...raw, message: text };
  }
  return raw;
}
