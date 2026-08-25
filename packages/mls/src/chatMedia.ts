/**
 * End-to-end encrypted chat attachments (R-3) — the rules BOTH clients follow.
 *
 * Until this file existed, a chat picture was uploaded as plaintext to a public
 * CDN URL and only the URL STRING was sealed into the MLS message. So the
 * sentence "the server cannot read this" was true of the message and false of
 * the picture inside it: the operator could open every image in a secret topic
 * or a DM, as could anyone who obtained the link, and nothing ever deleted
 * them. A per-tier encryption banner shipped over that would have been a lie.
 *
 * What replaces it:
 *   1. the client encrypts the file under the topic's TAK — the same key and
 *      derivation the message archive already uses (`takSession.sealMedia`),
 *   2. the CIPHERTEXT is uploaded and the server stores it as opaque bytes,
 *   3. the object reference travels INSIDE the sealed message body as a small
 *      JSON envelope, so neither the reference nor the key ever reaches the
 *      server in the clear,
 *   4. the reader fetches the ciphertext through a membership-gated route and
 *      decrypts it locally.
 *
 * ONE copy, in `@openstoa/mls`. `src/lib/chatMedia.ts` (web/server),
 * `packages/mobile/src/lib/chatMedia.ts` (mini-app) and
 * `packages/sdk/src/chatMedia.ts` (agent SDK) are re-export files, so keep this
 * one dependency-free — it is compiled by Next, by Metro and by tsc.
 *
 * The ciphertext moves as RAW BYTES, not base64 in JSON. See
 * `MAX_REQUEST_BODY_BYTES` for why that is the difference between a 7MB
 * attachment and a 9MB one, and `chatMediaCiphertextFilename` for how the
 * mini-app receives them without crossing the RN bridge.
 */
import { readImageDimensions, stripImageMetadata } from './imageMetadata';

/**
 * Marks a message body as an attachment envelope rather than text.
 *
 * A prefix, not a bare JSON object: a member can type `{"v":1,...}` into the
 * composer, and a body that merely parses as JSON must never be able to make a
 * client fetch and render something. The version is in the prefix so a future
 * envelope shape is a different string entirely and old clients fall through to
 * "render as text" instead of mis-parsing it.
 */
export const CHAT_MEDIA_BODY_PREFIX = 'openstoa:media:v1:';

/**
 * How large a request body the transport actually carries.
 *
 * Next's App Router buffers the body when middleware is present — and this app
 * has `src/middleware.ts` — which caps it at 10MB with no per-route override
 * (vercel/next.js#68409). This is a limit on the FRAMED REQUEST, so it applies
 * whatever the body is: it does not care that the ciphertext is now raw bytes
 * rather than base64 inside JSON.
 *
 * What changed with the framing is how much of it the attachment gets to use.
 * As base64-in-JSON a plaintext of N bytes cost ~1.34N on the wire, so the
 * reachable maximum was ~7.1MB of a 10MB ceiling — a third of the budget spent
 * re-encoding bytes that were already bytes. As raw octets it costs N + 28, and
 * the same ceiling reaches ~9.5MB.
 *
 * Measured under the old framing, and the reason this constant exists at all: a
 * 7MB attachment (9.3MB body) uploaded; 7.5MB (10.0MB body) was rejected by the
 * transport before any handler ran, and the caller was told `Body must be JSON`.
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/**
 * Headroom under the transport limit.
 *
 * The measured boundary is INCLUSIVE — a body of exactly 10.0MB was rejected,
 * 9.3MB went through — and the limit applies to the framed request, which also
 * carries headers and the URL. Deriving a cap that lands exactly on the ceiling
 * would ship a maximum that fails, which is the bug this constant exists to
 * end. 5% back off the ceiling instead.
 *
 * Still 5% now that the body is raw bytes. It buys less absolute slack per byte
 * of payload than it did under base64, but what it is protecting against —
 * headers, the query string, and a boundary that is `<=` rather than `<` — did
 * not shrink with the encoding.
 */
const MEDIA_BODY_HEADROOM_BYTES = Math.floor(MAX_REQUEST_BODY_BYTES * 0.05);

/**
 * How many attachments one pick may carry.
 *
 * A memory bound, not a product one. The picker is asked for base64, so it
 * returns the ENCODED bytes for every selected asset in a single result — the
 * whole selection is resident before the first send starts. At the per-file cap
 * that is ~12.7MB of string apiece, so ten is ~127MB held at once on a phone.
 * Sending is sequential regardless, so a higher number would buy nothing but
 * peak memory.
 *
 * The upload itself no longer pays for base64 — the ciphertext leaves as raw
 * octets — but the PICKER still hands over base64, which is the remaining
 * encode on the send path and the reason this number cannot simply rise with
 * the cap.
 */
export const MAX_ATTACHMENTS_PER_PICK = 10;

/** 12-byte AES-GCM nonce + 16-byte tag, prepended/appended by `sealMediaBytes`. */
export const CHAT_MEDIA_AEAD_OVERHEAD_BYTES = 28;

/**
 * Plaintext cap.
 *
 * DERIVED from what the transport can carry, never declared beside it. It used
 * to be a flat 10MB — the number the UI promised and the server checked — while
 * base64 turned a 10MB file into a 13.3MB body, so anything over ~7.4MB died in
 * the body parser and came back as `Body must be JSON`. The person saw a broken
 * upload with no reason, and both the client guard and the server's own "too
 * large" check were unreachable.
 *
 * The `* 3 / 4` that used to sit here was base64's expansion. Removing that term
 * is the whole point of the binary transport: the same 10MB ceiling now reaches
 * ~9.5MB of picture instead of ~7.1MB. What remains is the AEAD frame the
 * sender is obliged to add, which is bytes on the wire like any other.
 *
 * Keep this an EXPRESSION over the transport limit. A literal here is exactly
 * what drifted last time, and `chatMediaSizeCap.test.ts` fails if one reappears.
 */
export const MAX_CHAT_MEDIA_BYTES =
  MAX_REQUEST_BODY_BYTES - MEDIA_BODY_HEADROOM_BYTES - CHAT_MEDIA_AEAD_OVERHEAD_BYTES;

/**
 * Server-side cap on the CIPHERTEXT, with a little slack over
 * plaintext+overhead so a client that is one nonce-length out of step with the
 * server is not rejected for an arithmetic difference.
 */
export const MAX_CHAT_MEDIA_CIPHERTEXT_BYTES = MAX_CHAT_MEDIA_BYTES + 1024;

/**
 * What an attachment upload and download are framed as, on both hops.
 *
 * Stated once, and used by the sender, the route and the reader. `octet-stream`
 * is the only honest label: the server is handling AEAD output it may not open,
 * so any media type it named would be a claim it is not entitled to make — and
 * a type it DID name is one a browser might try to sniff and render.
 */
export const CHAT_MEDIA_CONTENT_TYPE = 'application/octet-stream';

/**
 * Image types both clients can actually display.
 *
 * HEIC is deliberately absent. The old plaintext route transcoded it server-
 * side, which is exactly the capability end-to-end encryption removes — the
 * server cannot decode what it cannot read. So an image no browser can decode
 * has to be refused at the sender with an explanation, not silently uploaded
 * for a recipient who will only ever see a broken frame.
 */
export const CHAT_MEDIA_MIME_ALLOWLIST: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
];

/**
 * Extension for a saved attachment, chosen from a FIXED table.
 *
 * The mime is attacker-influenced: it rides inside the sealed envelope, which
 * any member of the topic composed. Interpolating it into a filename would let
 * one of them choose the name a recipient's browser writes to disk — path
 * separators, a leading dot, a second extension, `..`. So the declared type is
 * only ever used to LOOK UP a known-good suffix, never to build one.
 *
 * Falls back to `.bin` rather than to no extension: a file with no suffix is
 * one the operating system will guess about, and a guess is the thing being
 * avoided here.
 */
const CHAT_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/**
 * What a saved attachment is called.
 *
 * NOT the name the sender's file had — that is read once to help sniff the
 * type and then dropped, so by the time anyone saves a picture there is no
 * original name to restore. The `mediaId` stands in: it is already the
 * attachment's identity, it is hex so it cannot carry a separator, and it
 * makes two saves from one conversation distinguishable in a downloads folder.
 */
export function chatMediaFilename(mime: string | null | undefined, mediaId: string): string {
  const ext = (typeof mime === 'string' && CHAT_MEDIA_EXTENSIONS[mime]) || 'bin';
  return `openstoa-${safeMediaIdSegment(mediaId)}.${ext}`;
}

/**
 * The id, reduced to something that cannot change what path a name is.
 *
 * It is validated hex everywhere it enters the system, but a filename is the
 * wrong place to rely on that holding — a separator, a leading dot or a `..`
 * here decides what a device writes and where.
 */
function safeMediaIdSegment(mediaId: string): string {
  return String(mediaId ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'attachment';
}

/**
 * Where the mini-app parks a DOWNLOADED ciphertext before decrypting it.
 *
 * It needs a name of its own because the download lands on disk rather than in
 * memory: React Native's `Response.arrayBuffer()` is not dependable
 * (facebook/react-native#6743), so the bytes are fetched by the native layer
 * straight to a file and read from there. Distinct from `chatMediaFilename` on
 * purpose — that one names the PLAINTEXT copy a person is offered, and the two
 * colliding would mean saving a picture deleted the picture on screen.
 *
 * `.enc` rather than the real extension: nothing should mistake this for
 * something it can open, least of all a gallery indexer.
 */
export function chatMediaCiphertextFilename(mediaId: string): string {
  return `openstoa-${safeMediaIdSegment(mediaId)}.enc`;
}

/**
 * Where the mini-app parks the DECRYPTED bytes so `<Image>` can read them.
 *
 * A file rather than a `data:` URI. Re-encoding the plaintext to base64 for a
 * URI cost 694ms of a measured 3982ms on a 6MB attachment under Hermes, held a
 * multi-megabyte string alive for as long as the picture was on screen, and
 * bought nothing — the image decoder reads a `file://` URI perfectly well.
 *
 * Distinct from `chatMediaFilename` for the same reason as above: this copy is
 * the screen's, and the save flow's copy is the person's.
 */
export function chatMediaCacheFilename(mime: string | null | undefined, mediaId: string): string {
  const ext = (typeof mime === 'string' && CHAT_MEDIA_EXTENSIONS[mime]) || 'bin';
  return `openstoa-view-${safeMediaIdSegment(mediaId)}.${ext}`;
}

/** The object reference + key derivation inputs, carried inside the sealed body. */
export interface ChatMediaEnvelope {
  v: 1;
  /** R2 object key of the CIPHERTEXT. Topic-scoped; see `chatMediaObjectKey`. */
  key: string;
  /** Client-generated AEAD context (32 hex). Not the key — the key comes from the TAK. */
  mediaId: string;
  /** TAK version the bytes were sealed under: 0 = public archive root, else the MLS epoch. */
  takVersion: number;
  /** Decrypted content type, so the reader can display it without sniffing. */
  mime: string;
  /** Plaintext byte length, for progress and for sanity-checking a decrypt. */
  size: number;
  /**
   * Pixel dimensions of the image, so a reader can RESERVE ITS ROW before the
   * bytes arrive.
   *
   * Without these the placeholder is one line of text tall and the row grows by
   * hundreds of pixels the moment the picture decodes. Four of those in one
   * screen is what "the chat jumps to the middle when I open it" actually is:
   * the view was pinned to the newest message, the rows BELOW the anchor grew,
   * and the bottom walked away from the reader. `maintainVisibleContentPosition`
   * cannot help — it holds a row still, it does not stop a row from growing —
   * and the auto-scroll that would re-pin is gated on still being near the
   * bottom, which by then is false.
   *
   * OPTIONAL, and must stay optional: every message sent before this field
   * existed has no dimensions, and those rows still have to render. Readers
   * fall back to a fixed aspect ratio.
   */
  w?: number;
  h?: number;
}

/**
 * `chat/{topicId}/{userId}/{mediaId}.bin`.
 *
 * Topic-first so deleting a topic is a prefix sweep, and so a route can prove a
 * requested key belongs to the topic in the URL before it fetches anything. The
 * client's FILENAME never appears: it is attacker-controlled text that would
 * otherwise end up in an object key, a log line and a URL, and it carries no
 * information the envelope's `mime` does not.
 */
export function chatMediaObjectKey(topicId: string, userId: string, mediaId: string): string {
  return `topics/${topicId}/chat/${userId}/${mediaId}.bin`;
}

const MEDIA_ID_RE = /^[0-9a-f]{32}$/;
const TOPIC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shape + the two caller-controlled segments, so a key can be rebuilt from itself. */
const OBJECT_KEY_RE = /^topics\/[0-9a-fA-F-]{36}\/chat\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{32})\.bin$/;

/**
 * Is `key` a well-formed chat object key belonging to `topicId`?
 *
 * Both halves matter. The shape check is what stops `../` and absolute URLs
 * from reaching object storage; the topic check is what stops a member of topic
 * A from putting topic B's object key in an envelope and having the route fetch
 * it for them.
 *
 * REBUILT rather than prefix-matched. There used to be a `chatMediaTopicPrefix`
 * here, and it was a second answer to a question `src/lib/r2.ts` already
 * answers — `topicObjectPrefix` owns where a topic's objects live, and two
 * helpers that can disagree about that produce a deletion which misses half its
 * objects while looking like it worked. This file cannot import that one (it is
 * a dependency-free twin the mini-app also compiles), so it states the chat
 * SUBPATH once, in `chatMediaObjectKey`, and everything else here derives from
 * that function. `r2KeyLayout.test.ts` asserts the subpath still falls under
 * the owner's prefix, which is the check that catches a move.
 */
export function isChatMediaKeyForTopic(key: unknown, topicId: string): key is string {
  if (typeof key !== 'string' || key.includes('..')) return false;
  const m = OBJECT_KEY_RE.exec(key);
  if (!m) return false;
  return key === chatMediaObjectKey(topicId, m[1], m[2]);
}

/** A fresh AEAD context id. Random, never derived from the file or the user. */
export function newMediaId(): string {
  const raw = new Uint8Array(16);
  globalThis.crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < raw.length; i++) out += raw[i].toString(16).padStart(2, '0');
  return out;
}

/** base64 of arbitrary bytes, chunked so a 10MB attachment cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(s);
}

/** Inverse of bytesToBase64. Throws on malformed input — callers decide what that means. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * HEIC/HEIF container brands at bytes 4..12 of an ISO BMFF file.
 *
 * iPhone Photos hands the picker raw HEIC even when it reports a `.jpg`
 * filename, so the declared type cannot be trusted — this reads the bytes. The
 * plaintext upload route sniffs the same brands to transcode; here the answer
 * is a refusal instead, because there is no longer a server that may look.
 */
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'];

export function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  let ftyp = '';
  for (let i = 4; i < 8; i++) ftyp += String.fromCharCode(bytes[i]);
  if (ftyp !== 'ftyp') return false;
  let brand = '';
  for (let i = 8; i < 12; i++) brand += String.fromCharCode(bytes[i]);
  return HEIC_BRANDS.indexOf(brand) !== -1;
}

/**
 * The image type the BYTES say they are, or null if they are not one we render.
 *
 * The declared type cannot be trusted and, worse, is often simply absent: a
 * browser reports `''` for a file it does not recognise, a picker hands over an
 * asset with no `mimeType`, and a drag-and-drop can carry either. Deciding from
 * the declared type alone meant a real photo could be dropped in silence for
 * failing `startsWith('image/')` — which is exactly how an attach flow loses a
 * message without telling anyone.
 *
 * Sniffing also closes the reverse hole: a file CLAIMING `image/png` that is
 * something else gets the type its bytes earn, so the reader never renders an
 * attachment as a type it is not.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);
  const ascii = (from: number, to: number) => {
    let s = '';
    for (let i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  if (at(0) === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  return null;
}

/** Extension → type, the last resort when the bytes and the declaration both fail. */
const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * What type to send this file as: the bytes first, the declaration second, the
 * filename last, and null when none of the three names something we can render.
 *
 * Null means REPORT AN ERROR, never "skip quietly". A user who picked a file
 * and saw nothing happen has been told their message sent.
 */
export function resolveChatMediaMime(
  bytes: Uint8Array,
  declaredType?: string | null,
  filename?: string | null,
): string | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  if (typeof declaredType === 'string' && CHAT_MEDIA_MIME_ALLOWLIST.indexOf(declaredType) !== -1) {
    return declaredType;
  }
  const ext = typeof filename === 'string' ? filename.toLowerCase().split('.').pop() ?? '' : '';
  return EXTENSION_MIME[ext] ?? null;
}

/** Serialise an envelope into a message body. The body is what gets MLS-sealed. */
export function buildChatMediaBody(env: ChatMediaEnvelope): string {
  return CHAT_MEDIA_BODY_PREFIX + JSON.stringify(env);
}

/**
 * Read an envelope out of a message body, or null when the body is anything
 * else — ordinary text, a hostile imitation, a truncated envelope, a future
 * version. Null always means "render this as text", which is the safe outcome:
 * the worst case is a reader seeing a line of JSON, never a client acting on a
 * reference it should not have trusted.
 */
export function parseChatMediaBody(body: unknown): ChatMediaEnvelope | null {
  if (typeof body !== 'string') return null;
  if (!body.startsWith(CHAT_MEDIA_BODY_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(CHAT_MEDIA_BODY_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const e = parsed as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (typeof e.key !== 'string' || !OBJECT_KEY_RE.test(e.key) || e.key.includes('..')) return null;
  if (typeof e.mediaId !== 'string' || !MEDIA_ID_RE.test(e.mediaId)) return null;
  if (typeof e.takVersion !== 'number' || !Number.isInteger(e.takVersion) || e.takVersion < 0) return null;
  if (typeof e.mime !== 'string' || CHAT_MEDIA_MIME_ALLOWLIST.indexOf(e.mime) === -1) return null;
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0 || e.size > MAX_CHAT_MEDIA_BYTES) {
    return null;
  }
  /*
   * Dimensions are OPTIONAL but, when present, must be sane: a bad pair would
   * reserve a row of the wrong size, which is the very defect this exists to
   * fix. Rejected individually rather than failing the whole envelope, because
   * an unopenable attachment is worse than one that lays out imprecisely.
   */
  const dim = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 20000 ? v : undefined;

  // The key embeds the AEAD context, so an envelope naming one media id and a
  // key ending in another is inconsistent by construction — a hand-edited body.
  if (!e.key.endsWith(`/${e.mediaId}.bin`)) return null;
  return {
    v: 1,
    key: e.key,
    mediaId: e.mediaId,
    takVersion: e.takVersion,
    mime: e.mime,
    size: e.size,
    w: dim(e.w),
    h: dim(e.h),
  };
}

/** Whether a body is an attachment, without paying for a full parse. */
export function isChatMediaBody(body: unknown): boolean {
  return typeof body === 'string' && body.startsWith(CHAT_MEDIA_BODY_PREFIX);
}

/** Why an attachment could not be sent. Each maps to its own message in the UI. */
export type ChatMediaSendFailure =
  /** Nothing to send — a 0-byte pick, or a file that vanished. */
  | 'empty'
  /** Over `MAX_CHAT_MEDIA_BYTES`. */
  | 'too-large'
  /** A type no client can display; see `CHAT_MEDIA_MIME_ALLOWLIST`. */
  | 'unsupported-type'
  /** HEIC — see `isHeicBytes`. Its own case because the advice differs. */
  | 'heic-unsupported'
  /**
   * The metadata could not be removed, so nothing was sent.
   *
   * Fails closed, following Signal-iOS, which treats a failed strip as a
   * send-blocking error rather than falling back to sending the original. The
   * only way here is a container this client cannot walk — a truncated file,
   * or an image type no recipient could have rendered anyway.
   */
  | 'strip-failed'
  /** This device holds no key it may seal under yet (public root not verified). */
  | 'no-key'
  /** Object storage refused the ciphertext. */
  | 'upload-failed'
  /** The message POST failed. The uploaded object has been discarded. */
  | 'send-failed';

export class ChatMediaError extends Error {
  constructor(
    readonly reason: ChatMediaSendFailure,
    message?: string,
    /**
     * Present only for `send-failed` under `retainForRetry`: the bytes are
     * stored and this names them, so a retry can re-send WITHOUT re-uploading.
     */
    readonly envelope?: ChatMediaEnvelope,
  ) {
    super(message ?? reason);
    this.name = 'ChatMediaError';
  }
}

export interface ChatMediaSendDeps {
  /** `takSession.sealMedia` — null when no key may be sealed under. */
  seal(mediaId: string, bytes: Uint8Array): Promise<{ ciphertext: Uint8Array; takVersion: number } | null>;
  /**
   * Upload the ciphertext; resolves to the stored object key.
   *
   * RAW BYTES, not base64. It took a string until the transport did, and the
   * cost was paid twice — once turning bytes into a 4/3-larger string, once
   * making the string a JSON body — for an encoding neither end wanted.
   */
  upload(ciphertext: Uint8Array, mediaId: string): Promise<string>;
  /** MLS-seal and POST the body. */
  send(body: string): Promise<void>;
  /** Delete an uploaded object. Only called to clean up after a failed send. */
  discard(objectKey: string): Promise<void>;
  /**
   * Tell the server the message referencing this object went out (M-1).
   *
   * Optional, and deliberately un-awaited-for-correctness: the send has already
   * succeeded by the time it runs, so a failed claim must not turn a delivered
   * message into an error. An unclaimed object is collected after a grace
   * window — but a successful READ claims it as well, server-side, so the
   * failure mode here is repaired by the first person who opens the picture.
   */
  claim?(objectKey: string): Promise<void>;
  /**
   * KEEP the uploaded object when the send fails, instead of deleting it.
   *
   * Set by a client that puts the failed message in the CONVERSATION with a
   * retry, because retry must reuse the bytes already stored rather than
   * re-reading a file the user may no longer have selected. The object is left
   * unclaimed, so if the user neither retries nor discards it, the M-1
   * collector removes it after the grace window — which is exactly the case
   * that mechanism exists for.
   *
   * Default (false) is the older behaviour: delete immediately, no retry
   * offered. A client without a failed-attachment row must leave it that way,
   * or it strands an object it will never mention again.
   */
  retainForRetry?: boolean;
}

/**
 * Encrypt, upload, and send one attachment — the whole flow, in one place both
 * clients call.
 *
 * It lives here rather than in each chat screen for two reasons. The encryption
 * step is a security boundary, and a boundary that exists twice is one somebody
 * eventually edits once. And the upload/send pair needs a guarantee neither
 * screen was giving: the upload happens FIRST, so a message POST that fails
 * leaves a paid-for, undeletable, unreferenced object in storage — the envelope
 * naming it never reached anyone, so nothing will ever clean it up. This
 * discards it before rethrowing.
 */
export async function sendEncryptedChatMedia(
  input: { bytes: Uint8Array; mime: string },
  deps: ChatMediaSendDeps,
): Promise<ChatMediaEnvelope> {
  const { bytes, mime } = input;
  if (bytes.length === 0) throw new ChatMediaError('empty');
  if (bytes.length > MAX_CHAT_MEDIA_BYTES) throw new ChatMediaError('too-large');
  if (isHeicBytes(bytes)) throw new ChatMediaError('heic-unsupported');
  if (CHAT_MEDIA_MIME_ALLOWLIST.indexOf(mime) === -1) throw new ChatMediaError('unsupported-type');

  /*
   * The metadata comes off HERE, at the last moment the plaintext exists.
   *
   * It cannot be done anywhere else. The post-upload path scrubs server-side
   * with sharp, because there the server holds the pixels; here it holds
   * ciphertext it may not open, so a camera JPEG's GPS coordinates, capture
   * time, body serial number and embedded thumbnail would travel end-to-end
   * encrypted straight to the recipient — encrypted against the operator, and
   * fully readable by the person the sender is least likely to have thought
   * about. Policy and evidence: `docs/design/image-metadata-policy.md`.
   *
   * Unconditional, and NOT folded into any size or type check. Signal-Android
   * shipped GPS for two years because its strip was a side effect of scaling,
   * so an image small enough to skip the scaler skipped the strip with it.
   */
  let plaintext: Uint8Array;
  try {
    plaintext = stripImageMetadata(bytes).bytes;
  } catch (err) {
    throw new ChatMediaError('strip-failed', err instanceof Error ? err.message : String(err));
  }
  /*
   * Re-checked, because the cap is now about the bytes actually being sent.
   * A strip all but always shrinks a file, but re-emitting the orientation
   * adds a few dozen bytes, and a picture sitting exactly on the cap would
   * come out over it — producing an envelope `parseChatMediaBody` refuses,
   * i.e. an attachment nobody in the room can open, rather than an error the
   * sender can act on.
   */
  if (plaintext.length > MAX_CHAT_MEDIA_BYTES) throw new ChatMediaError('too-large');

  const mediaId = newMediaId();
  const sealed = await deps.seal(mediaId, plaintext);
  if (!sealed) throw new ChatMediaError('no-key');

  let objectKey: string;
  try {
    objectKey = await deps.upload(sealed.ciphertext, mediaId);
  } catch (err) {
    throw new ChatMediaError('upload-failed', err instanceof Error ? err.message : String(err));
  }

  /*
   * Measured from the STRIPPED bytes, which is what the reader will decode —
   * a strip can re-emit orientation but never changes the pixel grid, so this
   * is the size the reader's row has to be. Header-only, so it costs
   * microseconds next to the seal that just ran.
   *
   * Null is fine and must stay fine: an unreadable header means the reader
   * falls back to a fixed aspect, exactly as it does for every message sent
   * before this field existed.
   */
  const dims = readImageDimensions(plaintext);

  const envelope: ChatMediaEnvelope = {
    v: 1,
    key: objectKey,
    mediaId,
    takVersion: sealed.takVersion,
    mime,
    // The STRIPPED length: this is what was sealed, so it is what the reader
    // will get back and what the envelope has to describe.
    size: plaintext.length,
    w: dims?.width,
    h: dims?.height,
  };
  try {
    await deps.send(buildChatMediaBody(envelope));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (deps.retainForRetry) {
      /*
       * The bytes are good and stored; only the message failed. Deleting them
       * here would make "retry" mean "pick the file again", which is both worse
       * than the text path (where a failed message is recoverable in place) and
       * impossible if the user has since navigated away from it. The envelope
       * rides on the error so the caller can offer a retry that re-sends
       * exactly this object.
       */
      throw new ChatMediaError('send-failed', message, envelope);
    }
    // Best-effort: a failed cleanup is an orphan object, a failed rethrow is a
    // user who thinks their picture was sent.
    try {
      await deps.discard(objectKey);
    } catch {
      /* nothing further to try */
    }
    throw new ChatMediaError('send-failed', message);
  }
  // The message is out. Claiming is bookkeeping from here on, so its failure is
  // swallowed — reporting it would tell the sender their picture did not send,
  // which would be false.
  if (deps.claim) {
    try {
      await deps.claim(objectKey);
    } catch {
      /* collected after the grace window if nobody ever reads it */
    }
  }
  return envelope;
}

/**
 * What a reader ended up with. Three failures, three different sentences —
 * conflating them is what produces a permanent spinner that explains nothing.
 */
export type ChatMediaLoad =
  /*
   * `bytes` is NULL on a cache hit.
   *
   * A picture that was already decrypted on this device is displayed straight
   * from its file, so there is nothing to carry here — and carrying it would
   * mean reading a multi-megabyte plaintext back into JS for a row that only
   * needs a URI. The one caller that really does want the bytes (the share
   * sheet) reads them from the file when the button is pressed.
   */
  | { status: 'ok'; bytes: Uint8Array | null; mime: string }
  /** No key for this attachment YET. Same state as archive-locked history. */
  | { status: 'locked' }
  /** The ciphertext could not be fetched. Retryable. */
  | { status: 'fetch-failed' }
  /** Fetched, but the bytes are not what the envelope says. Not retryable. */
  | { status: 'decrypt-failed' };

export interface ChatMediaLoadDeps {
  /**
   * GET the ciphertext through the membership-gated route. Throws on failure.
   *
   * BYTES. The route answers `application/octet-stream` and has no JSON shape
   * to negotiate — the web reads `arrayBuffer()`, the mini-app has the native
   * filesystem download the object to disk and reads it back, and the agent SDK
   * reads `arrayBuffer()` too. A throw becomes `fetch-failed`, which is
   * retryable; anything that resolves is handed straight to the AEAD.
   */
  fetchCiphertext(objectKey: string): Promise<Uint8Array>;
  /** `takSession.openMedia`. */
  open(
    mediaId: string,
    takVersion: number,
    ciphertext: Uint8Array,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'no-key' | 'decrypt' }>;
}

export async function loadEncryptedChatMedia(
  env: ChatMediaEnvelope,
  deps: ChatMediaLoadDeps,
): Promise<ChatMediaLoad> {
  let ciphertext: Uint8Array;
  try {
    ciphertext = await deps.fetchCiphertext(env.key);
  } catch {
    return { status: 'fetch-failed' };
  }
  if (ciphertext.length === 0) return { status: 'fetch-failed' };
  const opened = await deps.open(env.mediaId, env.takVersion, ciphertext);
  if (opened.ok) return { status: 'ok', bytes: opened.bytes, mime: env.mime };
  return opened.reason === 'no-key' ? { status: 'locked' } : { status: 'decrypt-failed' };
}

// ---------------------------------------------------------------------------
// Failed attachments that survive a restart
// ---------------------------------------------------------------------------

/**
 * A failed attachment, kept across restarts so it is still there when the user
 * comes back.
 *
 * Why this exists: a failed row lived in component state, so it vanished on a
 * reload. On the web that is a tab the user closed on purpose. On a phone it is
 * the OS reclaiming a backgrounded app — the user did nothing, and the outcome
 * was that the photo was simply gone, with no row, no error, and the uploaded
 * bytes collected within the hour. That is worse than the original defect,
 * which at least left something on screen.
 *
 * What is stored is a REFERENCE, not a picture: the sealed body (which names an
 * object and its TAK version) and the object key. Both are already inside a
 * message the sender wrote, and both sit beside an MLS keystore that is
 * strictly more sensitive. The bytes stay where they were uploaded.
 */
export interface PersistedFailedMedia {
  /** The provisional row id, so a restored row can be retried and removed. */
  rowId: string;
  /** The sealed message body — an envelope, so it re-sends without re-uploading. */
  body: string;
  /** The object key, so Discard can delete the bytes. */
  key: string;
  /** When the send failed, epoch ms. Decides both prompts below. */
  createdAt: number;
}

/**
 * How long a restored row still offers RETRY.
 *
 * Tied to the collector's grace window, because that is when the object stops
 * being there: an unclaimed attachment is collected an hour after upload, so a
 * row older than that names bytes that are probably gone. Past it the row is
 * still SHOWN — silence is the defect — but it says the attachment expired
 * rather than offering a retry that would post a message pointing at nothing.
 */
export const CHAT_MEDIA_RETRY_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a failed row is kept at all.
 *
 * A row that never goes away is litter in the conversation, and after a day the
 * user has either dealt with it or stopped caring. Cleared earlier by a
 * successful retry or by Discard — this is only the backstop for a row nobody
 * ever touched.
 */
export const CHAT_MEDIA_FAILED_ROW_TTL_MS = 24 * 60 * 60 * 1000;

/** Newest-first cap per topic, so a broken connection cannot fill the screen. */
export const MAX_PERSISTED_FAILED_MEDIA = 20;

/** Is this row past the point where retrying could still find its object? */
export function isFailedMediaExpired(row: PersistedFailedMedia, now: number): boolean {
  return now - row.createdAt > CHAT_MEDIA_RETRY_WINDOW_MS;
}

/**
 * Read back what was stored, discarding anything that is not a usable failed
 * row: wrong shape, a body that is not an envelope, a key that disagrees with
 * the body, or a row past its TTL. Never throws — storage is a place other
 * software can write to, and a corrupt entry must cost a row, not the room.
 */
export function parseFailedMedia(raw: unknown, now: number): PersistedFailedMedia[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: PersistedFailedMedia[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.rowId !== 'string' || !r.rowId) continue;
    if (typeof r.key !== 'string' || typeof r.body !== 'string') continue;
    if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) continue;
    if (now - r.createdAt > CHAT_MEDIA_FAILED_ROW_TTL_MS) continue;
    const envelope = parseChatMediaBody(r.body);
    if (!envelope || envelope.key !== r.key) continue;
    out.push({ rowId: r.rowId, body: r.body, key: r.key, createdAt: r.createdAt });
  }
  // Newest first, then capped: an old row is the one to lose.
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, MAX_PERSISTED_FAILED_MEDIA);
}

/** Add one row, keeping the newest-first cap. Same id replaces, never duplicates. */
export function addFailedMedia(
  list: readonly PersistedFailedMedia[],
  row: PersistedFailedMedia,
): PersistedFailedMedia[] {
  const next = [row, ...list.filter((r) => r.rowId !== row.rowId)];
  next.sort((a, b) => b.createdAt - a.createdAt);
  return next.slice(0, MAX_PERSISTED_FAILED_MEDIA);
}

/** Drop one row — a successful retry, or a discard. */
export function removeFailedMedia(
  list: readonly PersistedFailedMedia[],
  rowId: string,
): PersistedFailedMedia[] {
  return list.filter((r) => r.rowId !== rowId);
}

/** Serialise for storage. Pairs with `parseFailedMedia`. */
export function serializeFailedMedia(list: readonly PersistedFailedMedia[]): string {
  return JSON.stringify(list);
}

/** True for a topic id shaped like the ids the routes accept. */
export function isTopicId(value: unknown): value is string {
  return typeof value === 'string' && TOPIC_ID_RE.test(value);
}
