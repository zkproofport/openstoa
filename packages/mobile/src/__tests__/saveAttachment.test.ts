/**
 * Keeping a chat picture, on a phone.
 *
 * Saving did not exist on either client, which matters more here than in an
 * ordinary messenger: an attachment is only readable on a device that holds
 * the topic's key, so until this the picture had nowhere else to go.
 *
 * The route is the share sheet rather than a direct write into the photo
 * library — that is where "Save Image", "Save to Files" and every other
 * destination already live, and it asks rather than assumes. So the
 * interesting cases are around the edges of that: a host binary with no
 * filesystem module, a write that fails, and above all the ORDER of write /
 * share / delete, because getting that wrong hands the sheet a path to
 * nothing.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract        → the decrypted BYTES are written verbatim, shared by file
 *                     URI, then cleaned up — no base64 anywhere on the path
 *   integrity       → the temporary file is deleted AFTER the sheet resolves,
 *                     never before — iOS reads it while the sheet is open
 *   integrity       → the bytes handed over are the plaintext given to it; it
 *                     never re-fetches or re-decrypts
 *   external        → no filesystem module is reported, not thrown; a failed
 *                     write does not open an empty sheet; a failed sheet is
 *                     reported and still cleans up
 *   external        → a delete that throws does not turn a successful save
 *                     into a failure
 *   hostile         → a mime from inside the sealed envelope cannot steer the
 *                     filename that gets written
 *   boundary        → an empty payload round-trips rather than throwing
 *   authz / UTF-8 / very large / race → N/A: the bytes are already decrypted on
 *                     this device, and the only string reaching a path is built
 *                     by `chatMediaFilename`, which has its own suite.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  saveAttachment,
  type AttachmentFile,
  type AttachmentFs,
  type AttachmentShare,
} from '../lib/saveAttachment';
import { chatMediaCacheFilename, chatMediaFilename } from '../lib/chatMedia';

const MEDIA_ID = 'a'.repeat(32);

/** Records the order of every native call, which is what the ordering test reads. */
function harness(over: { write?: () => void; del?: () => void; share?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  let written: { name: string; content: Uint8Array; encoding?: string } | null = null;
  let lastName = '';

  const file: AttachmentFile = {
    get uri() {
      return `file:///caches/${lastName}`;
    },
    write: vi.fn((content: Uint8Array, options?: { encoding?: string }) => {
      calls.push('write');
      /*
       * A mock that models the real thing's REFUSALS. `expo-file-system`'s
       * `write` takes a string or a Uint8Array and would happily write the
       * WORD "AQID" if handed base64 without an encoding option — a file that
       * is four bytes of ASCII rather than a picture, and a save that "works"
       * and produces something no viewer can open. So a non-Uint8Array is a
       * throw here, not a recorded call.
       */
      if (!(content instanceof Uint8Array)) {
        throw new TypeError(`write expects bytes, got ${typeof content}`);
      }
      written = { name: lastName, content, encoding: options?.encoding };
      over.write?.();
    }),
    bytes: vi.fn(async () => {
      calls.push('bytes');
      return written?.content ?? new Uint8Array(0);
    }),
    delete: vi.fn(() => {
      calls.push('delete');
      over.del?.();
    }),
  };

  const fs: AttachmentFs = {
    cacheFile: vi.fn((name: string) => {
      lastName = name;
      return file;
    }),
    download: vi.fn(async () => {
      throw new Error('saveAttachment must never download anything');
    }),
  };

  const share: AttachmentShare = {
    share: vi.fn(async (c: { url: string }) => {
      calls.push(`share:${c.url}`);
      if (over.share) return over.share();
      return undefined;
    }),
  };

  return { fs, file, share, calls, written: () => written };
}

describe('saveAttachment', () => {
  it('CONTRACT: writes the bytes verbatim, shares the file, then cleans up', async () => {
    const h = harness();

    const res = await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });

    expect(res).toEqual({ status: 'shared' });
    expect(h.fs.cacheFile).toHaveBeenCalledWith(`openstoa-${MEDIA_ID}.png`);
    expect(h.written()).toEqual({
      name: `openstoa-${MEDIA_ID}.png`,
      content: new Uint8Array([1, 2, 3]),
      // No encoding option: the content is already bytes. Passing `base64`
      // here with a byte array is how you write a file of the wrong length.
      encoding: undefined,
    });
    expect(h.share.share).toHaveBeenCalledWith({
      url: `file:///caches/openstoa-${MEDIA_ID}.png`,
    });
  });

  it('INTEGRITY: the file is deleted AFTER the sheet, never before', async () => {
    /*
     * The ordering bug this test exists for. iOS reads the file while the
     * share sheet is open, so deleting any earlier hands every extension a
     * path to nothing — and the failure presents as "saving is broken on iOS"
     * rather than as a lifecycle mistake.
     */
    const h = harness();

    await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/jpeg',
      mediaId: MEDIA_ID,
    });

    expect(h.calls.map((c) => c.split(':')[0])).toEqual(['write', 'share', 'delete']);
  });

  it('INTEGRITY: it shares exactly the bytes it was given', async () => {
    // No second fetch and no second decrypt: the plaintext is already in hand,
    // and a round trip could only bring back the ciphertext.
    const h = harness();
    const PLAINTEXT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: PLAINTEXT,
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });

    expect(Array.from(h.written()!.content)).toEqual(Array.from(PLAINTEXT));
  });

  it('CONTRACT: the copy it writes is NOT the file the picture is displayed from', async () => {
    /*
     * The screen keeps the decrypted picture in a cache file under
     * `chatMediaCacheFilename` and hands `<Image>` its `file://` URI. This
     * function DELETES what it writes once the sheet closes, so if the two
     * names collided, saving a picture would erase the picture on screen — a
     * bug that would only ever be seen by someone who pressed Save.
     */
    const h = harness();
    await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });
    const savedName = (h.fs.cacheFile as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(savedName).toBe(chatMediaFilename('image/png', MEDIA_ID));
    expect(savedName).not.toBe(chatMediaCacheFilename('image/png', MEDIA_ID));
    expect(h.file.delete).toHaveBeenCalled();
  });

  it('EXTERNAL: a host with no filesystem module is reported, not thrown', async () => {
    // An older host binary. Losing the save is a missing feature; a throw here
    // would be a crash in the middle of looking at a picture.
    const h = harness();

    await expect(
      saveAttachment({
        fs: null,
        share: h.share,
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        mediaId: MEDIA_ID,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(h.share.share).not.toHaveBeenCalled();
  });

  it('EXTERNAL: a failed write does not open a sheet over nothing', async () => {
    const h = harness({
      write: () => {
        throw new Error('disk full');
      },
    });

    const res = await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });

    expect(res).toEqual({ status: 'write-failed' });
    expect(h.share.share).not.toHaveBeenCalled();
    // Nothing landed, so there is nothing to remove either.
    expect(h.file.delete).not.toHaveBeenCalled();
  });

  it('EXTERNAL: a sheet that fails to open is reported, and still cleans up', async () => {
    const h = harness({
      share: async () => {
        throw new Error('no sheet');
      },
    });

    const res = await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });

    expect(res).toEqual({ status: 'share-failed' });
    // A file left behind for every failed save would be a slow leak nobody
    // would ever go looking for.
    expect(h.file.delete).toHaveBeenCalled();
  });

  it('EXTERNAL: a delete that throws does not spoil a successful save', async () => {
    const h = harness({
      del: () => {
        throw new Error('gone already');
      },
    });

    await expect(
      saveAttachment({
        fs: h.fs,
        share: h.share,
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        mediaId: MEDIA_ID,
      }),
    ).resolves.toEqual({ status: 'shared' });
  });

  it('HOSTILE: a mime from the sealed envelope cannot steer the filename', async () => {
    // The mime was written by whichever member sent the message. If it reached
    // the filename, they would be choosing what this device writes and where.
    const h = harness();

    await saveAttachment({
      fs: h.fs,
      share: h.share,
      bytes: new Uint8Array([1, 2, 3]),
      mime: '../../../etc/passwd',
      mediaId: MEDIA_ID,
    });

    expect(h.fs.cacheFile).toHaveBeenCalledWith(`openstoa-${MEDIA_ID}.bin`);
    expect(h.written()?.name).not.toContain('..');
  });

  it('BOUNDARY: an empty payload round-trips rather than throwing', async () => {
    // Not this function's job to rule a zero-byte attachment impossible — it
    // writes what it is handed and lets the sheet deal with it.
    const h = harness();

    await expect(
      saveAttachment({
        fs: h.fs,
        share: h.share,
        bytes: new Uint8Array(0),
        mime: 'image/png',
        mediaId: MEDIA_ID,
      }),
    ).resolves.toEqual({ status: 'shared' });
  });
});
