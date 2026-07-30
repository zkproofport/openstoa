/**
 * Portable TAK (Topic Archive Key) crypto for Phase 3 history back-fill.
 *
 * MLS forward secrecy stops a new member from reading pre-join messages; the TAK
 * layer re-encrypts past bodies under a key the new member CAN be given (RFC 9750
 * §6.7 sanctions this "out of MLS" archive). This module is the portable crypto
 * core (no storage, no HTTP) — the web client and node tests use it directly and
 * the mobile mini-app ports it with the noble provider.
 *
 * Two tiers (design §5.2):
 *   - public  → a single random `archiveRootKey` per topic (1 key = whole
 *     history; not revocable, access-control only). Every member holds it and
 *     encrypts archives under it; a new member is simply handed the root.
 *   - private/secret/AI → per-epoch keys derived from the MLS exporter:
 *     TAK(N) = mlsExporter(exporterSecret@N, "openstoa-tak/v1", topic_id‖N).
 *     Only a member present at epoch N can derive TAK(N) (forward secrecy), so
 *     each member CACHES TAK(N) as it processes epoch N. A new member is granted
 *     only the epochs in its scope — epochs outside the grant stay unreadable
 *     (revocable by omission).
 *
 * Delivery (D5 + CVE-2024-47080/-47824 gate, §5.5): a TAK bundle is HPKE-sealed
 * to the recipient device's **MLS leaf encryption key read from the sender's own
 * validated ratchet tree**. Reading the key from validated group state — never a
 * server-supplied blob — is the identity gate: the sender can only wrap to a key
 * that genuinely belongs to a verified group member, so a malicious server cannot
 * substitute a fake device key to steal history.
 */
import * as gc from './groupClient';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u); // present on browser, node, and the RN polyfill
  return u;
}

const TAK_LABEL = 'openstoa-tak/v1';
const ARCHIVE_LABEL = 'openstoa-archive/v1';
const TAK_LEN = 32;
const ARCHIVE_KEY_LEN = 16; // matches the suite AEAD (AES-128-GCM)

/** topic_id ‖ epoch (8-byte big-endian) — the exporter context binding. */
function takContext(topicId: string, epoch: number): Uint8Array {
  const t = enc.encode(topicId);
  const e = new Uint8Array(8);
  new DataView(e.buffer).setBigUint64(0, BigInt(epoch), false);
  const out = new Uint8Array(t.length + 8);
  out.set(t, 0);
  out.set(e, t.length);
  return out;
}

/**
 * Per-epoch TAK from the live MLS exporter. Defaults to the state's current
 * epoch — the only epoch whose exporter secret a member holds (MLS discards past
 * key schedules), so the caller must derive + CACHE this as each epoch is
 * processed. Returns 32 raw bytes.
 */
export async function deriveEpochTak(state: gc.GroupState, topicId: string, epoch?: number): Promise<Uint8Array> {
  const cs = await gc.ciphersuiteImpl();
  const ep = epoch ?? gc.currentEpoch(state);
  return gc.mlsExporter(state.keySchedule.exporterSecret, TAK_LABEL, takContext(topicId, ep), TAK_LEN, cs);
}

/** Fresh random archive root key for a public topic (1 key = whole history). */
export function generatePublicRootKey(): Uint8Array {
  return randomBytes(TAK_LEN);
}

/** HKDF-derive the per-message 16-byte AEAD key from a TAK/root + message id. */
async function archiveKey(tak: Uint8Array, messageId: string): Promise<Uint8Array> {
  const cs = await gc.ciphersuiteImpl();
  // HKDF over the public Kdf interface. This impl requires the extract salt to
  // be exactly hash-length, so use a zero salt and bind the label + message id
  // in the expand info instead.
  const salt = new Uint8Array(cs.kdf.size);
  const prk = await cs.kdf.extract(salt, tak);
  const info = enc.encode(`${ARCHIVE_LABEL}:${messageId}`);
  return cs.kdf.expand(prk, info, ARCHIVE_KEY_LEN);
}

/**
 * Encrypt a message body for the archive under a TAK/root. Returns base64 of
 * nonce‖ciphertext. AEAD runs through the ciphersuite provider (subtle on web,
 * noble on mobile) so it matches the live-message path on every platform.
 */
export async function sealArchive(tak: Uint8Array, messageId: string, plaintext: string): Promise<string> {
  const cs = await gc.ciphersuiteImpl();
  const key = await archiveKey(tak, messageId);
  const nonce = randomBytes(cs.hpke.nonceLength);
  const ct = await cs.hpke.encryptAead(key, nonce, undefined, enc.encode(plaintext));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return b64(out);
}

/** Decrypt an archive body sealed by sealArchive. Returns null on failure. */
export async function openArchive(tak: Uint8Array, messageId: string, sealedB64: string): Promise<string | null> {
  try {
    const cs = await gc.ciphersuiteImpl();
    const key = await archiveKey(tak, messageId);
    const raw = unb64(sealedB64);
    const nonce = raw.slice(0, cs.hpke.nonceLength);
    const ct = raw.slice(cs.hpke.nonceLength);
    const pt = await cs.hpke.decryptAead(key, nonce, undefined, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/**
 * Fixed archive context for the PUSH-PREVIEW copy of a message (design §13.6
 * strategy A — the iOS NSE decrypts the TAK copy, never the live MLS message,
 * because a stable TAK consumes no ratchet key and so can never desync the app).
 *
 * The normal archive binds its per-message AEAD key to the SERVER-assigned
 * message id, but the preview copy has to be sealed BEFORE the POST that mints
 * that id — so the preview uses this constant context instead. Consequence: the
 * preview key is stable per (TAK, topic) rather than per message. That is safe
 * here: confidentiality still rests entirely on the TAK (which the server never
 * sees), and every seal draws a fresh random 12-byte nonce, so AES-GCM stays far
 * inside its birthday bound (~n²/2^97) at any realistic chat volume.
 */
export const PUSH_PREVIEW_CONTEXT_ID = 'push-preview';

/** Seal a body for the push preview under a TAK/root (see PUSH_PREVIEW_CONTEXT_ID). */
export function sealPushPreview(tak: Uint8Array, plaintext: string): Promise<string> {
  return sealArchive(tak, PUSH_PREVIEW_CONTEXT_ID, plaintext);
}

/** Decrypt a push-preview blob (the reference impl the NSE mirrors). Null on failure. */
export function openPushPreview(tak: Uint8Array, sealedB64: string): Promise<string | null> {
  return openArchive(tak, PUSH_PREVIEW_CONTEXT_ID, sealedB64);
}

// ---------------------------------------------------------------------------
// Bundle wrapping (HPKE to a verified leaf key) + the CVE identity gate
// ---------------------------------------------------------------------------

export interface RecipientLeaf {
  leafIndex: number;
  hpkePublicKey: Uint8Array;
}

/**
 * All leaf encryption keys in the VALIDATED ratchet tree whose credential
 * identity equals `recipientUserId`. The result is the CVE gate: a bundle may be
 * wrapped only to one of these keys — keys that provably belong to a verified
 * member of this group, taken from local validated state, never from the server.
 * A user with multiple devices has multiple leaves; wrap to each to reach all.
 */
export function findRecipientLeaves(state: gc.GroupState, recipientUserId: string): RecipientLeaf[] {
  const out: RecipientLeaf[] = [];
  const tree = state.ratchetTree as Array<{ nodeType?: string; leaf?: { hpkePublicKey: Uint8Array; credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined>;
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
    const cred = node.leaf.credential;
    if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
    if (dec.decode(cred.identity) === recipientUserId) {
      out.push({ leafIndex: i / 2, hpkePublicKey: node.leaf.hpkePublicKey });
    }
  }
  return out;
}

/** A device id derived from a leaf key — stable per leaf, used to address bundles. */
export function leafDeviceId(hpkePublicKey: Uint8Array): string {
  return b64(hpkePublicKey);
}

export interface WrappedBundle {
  enc: string; // base64 HPKE KEM output
  ct: string; // base64 HPKE ciphertext
}

/** HPKE-seal a TAK bundle (any JSON-serializable payload) to a leaf's key. */
export async function wrapBundleToLeaf(hpkePublicKey: Uint8Array, payload: unknown): Promise<WrappedBundle> {
  const cs = await gc.ciphersuiteImpl();
  const pk = await cs.hpke.importPublicKey(hpkePublicKey);
  const info = enc.encode(ARCHIVE_LABEL);
  const r = await cs.hpke.seal(pk, enc.encode(JSON.stringify(payload)), info);
  return { enc: b64(r.enc), ct: b64(r.ct) };
}

/**
 * Open a bundle wrapped to OUR leaf key. Uses our own leaf HPKE private key from
 * the validated state's private path. Returns the parsed payload, or null if it
 * was not sealed to us (or is corrupt).
 */
export async function unwrapBundle<T = unknown>(state: gc.GroupState, wrapped: WrappedBundle): Promise<T | null> {
  try {
    const cs = await gc.ciphersuiteImpl();
    const leafIndex = state.privatePath.leafIndex as number;
    const privBytes = (state.privatePath.privateKeys as Record<number, Uint8Array>)[leafIndex * 2];
    if (!privBytes) return null;
    const sk = await cs.hpke.importPrivateKey(privBytes);
    const info = enc.encode(ARCHIVE_LABEL);
    const pt = await cs.hpke.open(sk, unb64(wrapped.enc), unb64(wrapped.ct), info);
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bundle payload shapes (the JSON inside the HPKE envelope)
// ---------------------------------------------------------------------------

/** public-tier bundle: the single archive root (whole history). */
export interface PublicBundle {
  tier: 'public';
  rootKey: string; // base64 archiveRootKey
}

/** private/secret/AI bundle: the granted per-epoch TAKs. */
export interface ScopedBundle {
  tier: 'scoped';
  taks: Record<string, string>; // epoch -> base64 TAK
}

export type TakBundlePayload = PublicBundle | ScopedBundle;
