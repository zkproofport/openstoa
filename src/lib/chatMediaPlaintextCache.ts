/**
 * The plaintext of an attachment THIS tab just sent, kept in memory so the
 * sender's own bubble does not download and decrypt what it already holds.
 *
 * THE WASTE THIS REMOVES. `ChatMediaAttachment` is written from the reader's
 * point of view: it has an envelope naming an object, so it fetches the object
 * and opens it. That is right for every bubble except one — the sender's, which
 * renders milliseconds after the same tab encrypted those exact bytes and
 * uploaded them, then threw the plaintext away. On staging a 7.7MB image took
 * 8661ms before the SENDER could see it, of which the crypto was 18ms; 2441ms of
 * the remainder was that redundant round trip (41ms against a local container,
 * which is why it is invisible in development). The sender pays for the upload
 * on the UPLINK and then pays again on the downlink for a picture it chose.
 *
 * IDENTICAL, NOT MERELY SIMILAR. What is stored is the exact `Uint8Array` handed
 * to `sealMedia` — post-EXIF-strip, post-HEIC-conversion — together with the
 * mime the envelope carries. So the `Blob` a cache hit builds is byte-for-byte
 * the `Blob` a reload builds after fetching and decrypting, and the download
 * filename (`chatMediaFilename(mime, mediaId)`) is the same string. A bubble
 * that rendered from here and the same bubble after F5 cannot diverge, which
 * matters because both surfaces key their image cache on the URL and would have
 * no way to notice if they did.
 *
 * NOT A PERSISTENT CACHE, and deliberately not. It lives for the tab, holds only
 * what this tab sent, and is bounded in BYTES rather than entries — an entry is
 * up to `MAX_CHAT_MEDIA_BYTES`, so counting entries bounds nothing useful. A
 * miss is never an error: the reader path is still there and still correct, and
 * that is what runs after a reload, on the recipient's device, and on the
 * sender's second device.
 *
 * Plaintext in memory is not a new exposure: this is the same process that has
 * the picture on screen in a `<img>` and its bytes in a blob URL.
 */

/** Roughly two full-size attachments. Past this, the oldest entry is dropped. */
const MAX_CACHED_BYTES = 24 * 1024 * 1024;

interface Entry {
  bytes: Uint8Array;
  mime: string;
}

/** Insertion-ordered, which is what makes "drop the oldest" a `keys().next()`. */
const cache = new Map<string, Entry>();
let cachedBytes = 0;

/**
 * Remember what was sealed under `mediaId`.
 *
 * Called from the SEAL step, because that is the only place the stripped
 * plaintext and the id exist together — `sendEncryptedChatMedia` derives the id
 * internally and does not hand the stripped bytes back.
 */
export function rememberSentChatMedia(mediaId: string, bytes: Uint8Array, mime: string): void {
  if (cache.has(mediaId)) return;
  // A single attachment larger than the whole budget would evict everything and
  // then still not fit. Skip it rather than empty the cache for nothing.
  if (bytes.length > MAX_CACHED_BYTES) return;
  cache.set(mediaId, { bytes, mime });
  cachedBytes += bytes.length;
  while (cachedBytes > MAX_CACHED_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const dropped = cache.get(oldest.value)!;
    cache.delete(oldest.value);
    cachedBytes -= dropped.bytes.length;
  }
}

/**
 * The plaintext for an envelope this tab sent, or null.
 *
 * READ, not take: the entry stays. A bubble re-renders (a retry, a theme
 * change, a re-mount inside the same tab) and must keep showing the picture
 * rather than falling back to the network the second time.
 *
 * `expectedSize` is the envelope's own `size`, and a mismatch returns null
 * rather than the bytes: the envelope describes what the reader must get back,
 * so anything that disagrees with it is not the thing being asked for, and
 * falling through to the network is always a correct answer.
 */
export function readSentChatMedia(
  mediaId: string,
  expectedSize: number,
  expectedMime: string,
): Entry | null {
  const hit = cache.get(mediaId);
  if (!hit) return null;
  if (hit.bytes.length !== expectedSize || hit.mime !== expectedMime) return null;
  return hit;
}

/** Test seam. Nothing in the app calls this — the cache lives for the tab. */
export function __resetSentChatMediaCache(): void {
  cache.clear();
  cachedBytes = 0;
}
