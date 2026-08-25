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
import { leafBelongsTo } from './leafIdentity';

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
/**
 * A TAK is 32 bytes. Exported because callers outside this module need to
 * REJECT a value that is not one — an epoch key arriving in an invite link
 * has been through a channel we do not control, and length is the only
 * check available for a symmetric key before it either opens something or
 * does not.
 */
export const TAK_LEN = 32;
const ARCHIVE_KEY_LEN = 16; // matches the suite AEAD (AES-128-GCM)

/**
 * Domain-separated tag identifying WHICH public archive root a topic uses.
 * Deliberately NOT a raw hash/CRC of the root: the tag is published to the
 * server, so it must be one-way (the server must never be able to work back to
 * key material) AND bound to this one purpose, so it can never be replayed as
 * an archive key, a TAK, or any other derived value. 16 bytes is ample for
 * identity — collisions are the only failure mode and 2^128 is far past it.
 */
const ROOT_FINGERPRINT_LABEL = 'openstoa-archive-root-id/v1';
const ROOT_FINGERPRINT_LEN = 16;
/** base64 length of a ROOT_FINGERPRINT_LEN-byte value ("....==" for 16 bytes). */
export const ROOT_FINGERPRINT_B64_LEN = Math.ceil(ROOT_FINGERPRINT_LEN / 3) * 4;

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

/**
 * The topic-wide IDENTITY of a public archive root:
 *
 *     root_fingerprint = HKDF(root, "openstoa-archive-root-id/v1", 16 bytes)
 *
 * A single random root per public topic (§5.2) has no generation counter —
 * `tak_version` is pinned at 0 — so nothing in the archive rows themselves can
 * tell "the topic's real root" apart from a root some other device minted while
 * it was waiting for the real one. That is what let an orphan root be broadcast
 * over everyone's real root and make every archived row permanently unreadable.
 *
 * The fingerprint is that missing identity. One published value answers both
 * questions a client has to ask before it touches the archive:
 *   - does a root exist for this topic at all?  → the published value is non-null
 *   - is the root I hold the real one?          → my fingerprint equals it
 *
 * The server stores it as OPAQUE BYTES and never computes it (C1: the Delivery
 * Service stays crypto-free) — clients derive and compare. Deriving it costs one
 * HKDF and leaks nothing: it is one-way and domain-separated, so publishing it
 * neither reveals the root nor produces a value reusable anywhere else.
 *
 * Byte-identical on web and mobile: the label and length below are the wire
 * contract, and `packages/mobile/src/crypto/takClient.ts` is a byte-for-byte
 * mirror of this file. Changing either one on one platform silently splits the
 * two clients into different fingerprints for the same root.
 */
export async function deriveRootFingerprint(root: Uint8Array): Promise<string> {
  const cs = await gc.ciphersuiteImpl();
  // Same HKDF shape as archiveKey: zero salt of hash length (this Kdf impl
  // requires it), all domain separation carried in the expand info.
  const salt = new Uint8Array(cs.kdf.size);
  const prk = await cs.kdf.extract(salt, root);
  return b64(await cs.kdf.expand(prk, enc.encode(ROOT_FINGERPRINT_LABEL), ROOT_FINGERPRINT_LEN));
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
 * Encrypt raw bytes under a TAK/root, bound to `contextId`. Returns
 * nonce‖ciphertext. AEAD runs through the ciphersuite provider (subtle on web,
 * noble on mobile) so it matches the live-message path on every platform.
 */
async function sealBytes(tak: Uint8Array, contextId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const cs = await gc.ciphersuiteImpl();
  const key = await archiveKey(tak, contextId);
  const nonce = randomBytes(cs.hpke.nonceLength);
  const ct = await cs.hpke.encryptAead(key, nonce, undefined, plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of sealBytes. Null on any failure — wrong key, truncation, tampering. */
async function openBytes(tak: Uint8Array, contextId: string, sealed: Uint8Array): Promise<Uint8Array | null> {
  try {
    const cs = await gc.ciphersuiteImpl();
    const key = await archiveKey(tak, contextId);
    const nonce = sealed.slice(0, cs.hpke.nonceLength);
    const ct = sealed.slice(cs.hpke.nonceLength);
    return await cs.hpke.decryptAead(key, nonce, undefined, ct);
  } catch {
    return null;
  }
}

/**
 * Encrypt a message body for the archive under a TAK/root. Returns base64 of
 * nonce‖ciphertext.
 */
export async function sealArchive(tak: Uint8Array, messageId: string, plaintext: string): Promise<string> {
  return b64(await sealBytes(tak, messageId, enc.encode(plaintext)));
}

/** Decrypt an archive body sealed by sealArchive. Returns null on failure. */
export async function openArchive(tak: Uint8Array, messageId: string, sealedB64: string): Promise<string | null> {
  let raw: Uint8Array;
  try {
    raw = unb64(sealedB64);
  } catch {
    return null; // not even base64 — nothing to open
  }
  const pt = await openBytes(tak, messageId, raw);
  return pt == null ? null : dec.decode(pt);
}

/**
 * AEAD context for an attached FILE, as opposed to a message body.
 *
 * Media is sealed before the POST that mints a message id (the bytes have to be
 * uploaded first, so the body can reference them), so it cannot bind to that id
 * the way `sealArchive` does. It binds to a client-generated `mediaId` instead,
 * and the `media:` prefix keeps that namespace disjoint from message ids — the
 * two must never derive the same per-object key from the same TAK.
 */
function mediaContextId(mediaId: string): string {
  return `media:${mediaId}`;
}

/**
 * Encrypt an attached file under the topic's TAK/root (R-3).
 *
 * Chat attachments used to be uploaded as PLAINTEXT to a public CDN URL, with
 * only the URL string sealed — so the message was end-to-end encrypted and the
 * picture in it was not, readable by the operator and by anyone holding the
 * link. This is the same key and the same derivation the archive already uses,
 * so a member who can read a topic's history can read its pictures, and nobody
 * else can — including the server, which only ever sees this output.
 */
export function sealMediaBytes(tak: Uint8Array, mediaId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  return sealBytes(tak, mediaContextId(mediaId), plaintext);
}

/** Decrypt an attachment sealed by sealMediaBytes. Null on wrong key or tampering. */
export function openMediaBytes(tak: Uint8Array, mediaId: string, sealed: Uint8Array): Promise<Uint8Array | null> {
  return openBytes(tak, mediaContextId(mediaId), sealed);
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
    /*
     * MATCH THE ACCOUNT, not the whole credential.
     *
     * A leaf identity is `<userId>:<deviceId>` (see `leafIdentity`), so an
     * exact comparison against a user id could never match anything — and the
     * only caller, `grantScoped`, passes a user id. Every scoped grant sealed
     * to zero leaves and returned 0, which at the HTTP layer is
     * indistinguishable from "this device held no keys". The one place it was
     * visible was a person waiting for history that never arrived.
     *
     * `leafBelongsTo` is the same rule removal already uses to find every
     * device an account owns, which is exactly what a grant needs too.
     *
     * A legacy leaf with no user part is not attributed — the same refusal
     * `userIdOfLeaf` makes, and for the same reason: it belongs to SOMEBODY,
     * and guessing would hand keys to the wrong person.
     */
    const identity = dec.decode(cred.identity);
    if (leafBelongsTo(identity, recipientUserId) || identity === recipientUserId) {
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
