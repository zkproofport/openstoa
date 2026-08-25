/**
 * An attachment's bytes, on a phone, without ever becoming a string.
 *
 * Two hops used to run through base64, and both were expensive for a reason
 * that had nothing to do with the product. Measured under Hermes on a 6MB
 * attachment, the read path cost 3982ms end to end:
 *
 *     JSON.parse                21ms
 *     base64 -> bytes          179ms
 *     AES-GCM decrypt         3086ms
 *     bytes -> base64          694ms   (only to build a `data:` URI)
 *     data URI                   2ms
 *
 * ~894ms of that is encoding work on the JS thread, paid so that bytes could
 * pretend to be text on the way in and again on the way out. This module
 * removes both:
 *
 *   IN  — the ciphertext is downloaded by the NATIVE layer straight to a cache
 *         file and read back over JSI (`AttachmentFs.download` → `bytes()`).
 *         React Native's `Response.arrayBuffer()` is not dependable
 *         (facebook/react-native#6743) precisely because only strings cross the
 *         bridge, which is what made base64 the only option before.
 *   OUT — the decrypted bytes are written to a cache file and `<Image>` is given
 *         a `file://` URI, instead of a `data:` URI built from a
 *         multi-megabyte base64 string that then stays alive as long as the
 *         picture is on screen.
 *
 * Everything native is INJECTED. The mini-app does not install these modules —
 * it borrows the host's through a guarded `require` (see `attachmentFs.ts`) —
 * so a direct import here would make this untestable AND would hide the case
 * that matters most on a real device: a host binary that predates the module.
 */
import { MEDIA_DOWNLOAD_TIMEOUT_MS } from '@openstoa/api-types';
import type { AttachmentFile, AttachmentFs } from './saveAttachment';
import { chatMediaCacheFilename, chatMediaCiphertextFilename } from './chatMedia';

/** Where an attachment's ciphertext is fetched from, and with what credential. */
export interface ChatMediaFetchSpec {
  url: string;
  headers: Record<string, string>;
}

export interface DownloadCiphertextDeps {
  /** Null on a host build with no filesystem module. */
  fs: AttachmentFs | null;
  spec: ChatMediaFetchSpec;
  /** Names the temporary file. The AEAD context id, already validated hex. */
  mediaId: string;
  /**
   * Milliseconds before the download is abandoned. Defaults to the shared
   * `MEDIA_DOWNLOAD_TIMEOUT_MS`; a parameter only so a test does not have to
   * advance sixty seconds of fake time to prove one second of behaviour.
   */
  deadlineMs?: number;
}

/**
 * Give the native download a deadline the native download cannot defeat.
 *
 * Every OTHER request in this package carries one (`api/timeout.ts`), and this
 * one did not, because it is not a `fetch` — the ciphertext is streamed to disk
 * by the host's filesystem module, which a sweep for `fetch(` walks straight
 * past. The asymmetry that left: the WEB abandons an attachment download after
 * `MEDIA_DOWNLOAD_TIMEOUT_MS` (`components/ChatPanel.tsx`), while here the same
 * constant was re-exported and never used by anything. A peer that accepts the
 * connection and then goes quiet leaves the promise pending, and the bubble
 * spins with no error and no Reload — on the path every reader takes for every
 * picture.
 *
 * A RACE, not a cancel: `AttachmentFs.download` exposes no way to stop a
 * transfer in flight, so the transfer may well continue. That is acceptable and
 * the alternative is not — a deadline the supervised thing can defeat is not a
 * deadline, and what matters is that the CALLER is freed to report a retryable
 * failure.
 *
 * The abandoned transfer needs nothing done to it. `Promise.race` subscribes to
 * every promise it is given, so a download that fails long after this returned
 * already has a handler and can never surface as an unhandled rejection — a
 * defensive `work.catch(() => {})` here was dead code, which is how it was
 * found. Its temporary file is left alone deliberately: deleting it would be
 * deleting a file a transfer may still be writing to, and the next attempt
 * reuses the same name in the same cache directory anyway.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`attachment download timed out after ${ms}ms: ${url}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch one attachment's ciphertext.
 *
 * THROWS on every failure, which is the contract `loadEncryptedChatMedia`
 * expects — it turns a throw into `fetch-failed`, a retryable state with a
 * Reload control, and that is the honest answer for a missing module, a dead
 * network, an expired session and a collected object alike.
 *
 * The temporary file is removed before returning, on both the success and the
 * failure path. It holds ciphertext, so leaving it behind is not a disclosure —
 * it is a slow leak in a cache directory nobody would ever go looking in, one
 * file per picture opened.
 */
export async function downloadCiphertext(deps: DownloadCiphertextDeps): Promise<Uint8Array> {
  const { fs, spec, mediaId, deadlineMs = MEDIA_DOWNLOAD_TIMEOUT_MS } = deps;
  if (!fs) throw new Error('no filesystem module in this build');

  const name = chatMediaCiphertextFilename(mediaId);
  let file: AttachmentFile | null = null;
  try {
    file = await withDeadline(fs.download(spec.url, name, spec.headers), deadlineMs, spec.url);
    const bytes = await file.bytes();
    // A zero-byte file is a download that "succeeded" into nothing. Refusing it
    // here means the caller never hands an empty buffer to the decryptor, which
    // would report `decrypt-failed` — final-sounding, and wrong: this one is
    // worth retrying.
    if (bytes.length === 0) throw new Error('empty attachment');
    return bytes;
  } finally {
    if (file) {
      try {
        file.delete();
      } catch {
        // Cache directory; the OS reclaims it.
      }
    }
  }
}

export interface WriteDecryptedDeps {
  fs: AttachmentFs | null;
  bytes: Uint8Array;
  /** From the sealed envelope. Only ever used to LOOK UP a known-good suffix. */
  mime: string;
  mediaId: string;
}

/**
 * Park the decrypted bytes where `<Image>` can read them, and hand back the
 * file so the caller can delete it when the picture goes away.
 *
 * Null rather than a throw when there is no filesystem or the write fails: the
 * bytes decrypted correctly, so the reader is not in an error state — they are
 * in a "cannot display this here" state, and the caller decides what that
 * looks like.
 */
export function writeDecrypted(deps: WriteDecryptedDeps): AttachmentFile | null {
  const { fs, bytes, mime, mediaId } = deps;
  if (!fs) return null;
  try {
    const file = fs.cacheFile(chatMediaCacheFilename(mime, mediaId));
    file.write(bytes);
    return file;
  } catch {
    return null;
  }
}

/**
 * Remove a display file. Never throws — this runs from a React cleanup, where a
 * throw would take the unmount with it.
 */
export function discardDecrypted(file: AttachmentFile | null | undefined): void {
  if (!file) return;
  try {
    file.delete();
  } catch {
    // Cache directory; the OS reclaims it.
  }
}
