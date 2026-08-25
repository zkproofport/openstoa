/**
 * An attachment download that never answers becomes a retry, not a spinner.
 *
 * Every other request this package makes carries a deadline (`api/timeout.ts`).
 * This one did not, and the reason it was missed is worth writing down: the
 * ciphertext is NOT fetched. React Native cannot dependably receive binary over
 * `fetch` (facebook/react-native#6743), so the host's filesystem module streams
 * it to disk — and a sweep for `fetch(`, which is how the rest of this work
 * found its gaps, walks straight past `fs.download(...)`.
 *
 * The asymmetry that left is the giveaway: the web abandons an attachment
 * download after `MEDIA_DOWNLOAD_TIMEOUT_MS` (`components/ChatPanel.tsx`),
 * while the mini-app re-exported that same constant and no caller ever used it.
 * A peer that accepts the connection and then goes quiet left the promise
 * pending — on the path EVERY reader takes for EVERY picture, with no error and
 * no Reload, only a bubble that spins.
 *
 * What is asserted is the caller being freed, not the transfer being stopped:
 * `AttachmentFs.download` has no cancel, so the native side may well keep
 * going. A deadline the supervised thing can defeat is not a deadline.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a never-settling download REJECTS (the defect itself)
 *   contract   → the rejection is an Error, so `loadEncryptedChatMedia` turns
 *                it into `fetch-failed` — retryable, with a Reload — and never
 *                into `decrypt-failed`, which reads as final and would be a lie
 *   integrity  → the default deadline is the SHARED constant, not a number
 *                retyped here; web and mobile cannot drift apart again
 *   race       → an answer arriving just inside the limit still succeeds, and
 *                its bytes are returned intact
 *   race       → a download that rejects AFTER the deadline has passed does not
 *                surface as an unhandled rejection
 *   boundary   → a zero-byte file is still refused (the pre-existing guard is
 *                not bypassed by the new wrapper)
 *   empty      → a build with no filesystem module still throws its own error,
 *                before any deadline is involved
 *   external   → an immediate native rejection passes through unchanged
 *   N/A        → hostile / UTF-8 / authz: this is timing and control flow; the
 *                URL and headers are built elsewhere and asserted there
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MEDIA_DOWNLOAD_TIMEOUT_MS } from '@openstoa/api-types';
import { downloadCiphertext } from '../lib/chatMediaFiles';
import type { AttachmentFs, AttachmentFile } from '../lib/saveAttachment';

const MEDIA_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const SPEC = { url: 'https://stg-community.zkproofport.app/api/topics/t/chat/media?key=k', headers: {} };

function fileOf(bytes: Uint8Array): AttachmentFile {
  return {
    bytes: async () => bytes,
    delete: () => {},
  } as unknown as AttachmentFile;
}

/** A filesystem whose download never answers — the failure being guarded. */
function silentFs(): AttachmentFs {
  return {
    cacheFile: () => fileOf(new Uint8Array()),
    download: () => new Promise<AttachmentFile>(() => {}),
  } as unknown as AttachmentFs;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('attachment download deadline', () => {
  it('rejects a never-answering download instead of pending forever', async () => {
    const settled = downloadCiphertext({ fs: silentFs(), spec: SPEC, mediaId: MEDIA_ID }).then(
      () => 'resolved' as const,
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(MEDIA_DOWNLOAD_TIMEOUT_MS + 1);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    // An Error, not a string or a bare reject: `loadEncryptedChatMedia` turns a
    // throw into `fetch-failed`, which is the retryable state with a Reload.
    expect((outcome as Error).message).toContain('timed out');
  });

  it('defaults to the shared constant, so web and mobile cannot drift', async () => {
    let done = false;
    void downloadCiphertext({ fs: silentFs(), spec: SPEC, mediaId: MEDIA_ID }).catch(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(MEDIA_DOWNLOAD_TIMEOUT_MS - 1);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it('returns the bytes when the download answers inside the limit', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fs = {
      cacheFile: () => fileOf(payload),
      download: () =>
        new Promise<AttachmentFile>((resolve) => {
          setTimeout(() => resolve(fileOf(payload)), 500);
        }),
    } as unknown as AttachmentFs;

    const inflight = downloadCiphertext({ fs, spec: SPEC, mediaId: MEDIA_ID, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(600);

    expect(await inflight).toEqual(payload);
  });

  /*
   * This one held even with the wrapper's defensive `work.catch()` removed —
   * which is how that line was found to be dead: `Promise.race` subscribes to
   * both promises, so the abandoned download always has a handler. The test
   * stays because the PROPERTY is real and worth pinning; it just belongs to
   * `race`, not to anything this file writes.
   */
  it('does not leak an unhandled rejection when the download fails after the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    const fs = {
      cacheFile: () => fileOf(new Uint8Array()),
      download: () =>
        new Promise<AttachmentFile>((_resolve, reject) => {
          // Answers LATE, and with a failure — the caller gave up long ago.
          setTimeout(() => reject(new Error('socket closed')), 2_000);
        }),
    } as unknown as AttachmentFs;

    const settled = downloadCiphertext({
      fs,
      spec: SPEC,
      mediaId: MEDIA_ID,
      deadlineMs: 1_000,
    }).catch(() => 'gave up' as const);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await settled).toBe('gave up');

    // Now let the abandoned download reject.
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('still refuses a zero-byte file — the deadline does not bypass that guard', async () => {
    const empty = new Uint8Array();
    const fs = {
      cacheFile: () => fileOf(empty),
      download: async () => fileOf(empty),
    } as unknown as AttachmentFs;

    await expect(
      downloadCiphertext({ fs, spec: SPEC, mediaId: MEDIA_ID, deadlineMs: 1_000 }),
    ).rejects.toThrow('empty attachment');
  });

  it('still reports a build with no filesystem module', async () => {
    await expect(
      downloadCiphertext({ fs: null, spec: SPEC, mediaId: MEDIA_ID }),
    ).rejects.toThrow('no filesystem module in this build');
  });

  it('passes an immediate native failure through unchanged', async () => {
    const boom = new Error('403 from origin');
    const fs = {
      cacheFile: () => fileOf(new Uint8Array()),
      download: () => Promise.reject(boom),
    } as unknown as AttachmentFs;

    await expect(
      downloadCiphertext({ fs, spec: SPEC, mediaId: MEDIA_ID, deadlineMs: 1_000 }),
    ).rejects.toBe(boom);
  });
});
