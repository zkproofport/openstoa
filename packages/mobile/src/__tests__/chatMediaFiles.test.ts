/**
 * An attachment's bytes on a phone, without ever becoming a string.
 *
 * Two hops used to run through base64 for a reason that had nothing to do with
 * the product: React Native's `Response.arrayBuffer()` is not dependable
 * (facebook/react-native#6743) because only strings cross the bridge, so the
 * ciphertext had to arrive as base64-in-JSON — and the decrypted plaintext then
 * went back OUT through base64 to build a `data:` URI for `<Image>`. Measured
 * under Hermes on a 6MB attachment, that was 179ms in and 694ms out of a 3982ms
 * read, plus a multi-megabyte string kept alive for as long as the picture was
 * on screen.
 *
 * This module removes both by putting the bytes on disk instead: the native
 * layer downloads straight to a file, and the decrypted bytes are written to a
 * file whose `file://` URI is what `<Image>` reads.
 *
 * What is tested here is the LIFECYCLE, because that is where this shape goes
 * wrong — a temporary ciphertext file that is never removed, a display file
 * deleted while the image is still reading it, or a host binary with no
 * filesystem module turning a missing picture into a crash.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the download names the gated URL and carries the credential;
 *                the bytes returned are the file's bytes, verbatim
 *   integrity  → the temporary ciphertext file is deleted on success AND on
 *                every failure path
 *   boundary   → a zero-byte download is a FETCH failure (retryable), never a
 *                decrypt failure (final)
 *   boundary   → a single byte round-trips; bytes outside the base64 alphabet
 *                survive
 *   external   → no filesystem module, a download that rejects, a read that
 *                rejects, a write that throws, a delete that throws
 *   hostile    → a mime from the sealed envelope cannot steer either filename
 *   integrity  → the display filename and the SAVE filename are different, so
 *                saving cannot delete the picture on screen
 *   race       → cleanup is idempotent and never throws, because it runs from a
 *                React unmount
 *   authz / UTF-8 / very large → N/A: authorization is the route's (see
 *                `chat-media-route.test.ts`), the only strings reaching a path
 *                are built by `chatMedia.ts`'s filename helpers, and size is
 *                capped before anything reaches this layer.
 */
import { describe, it, expect, vi } from 'vitest';
import { discardDecrypted, downloadCiphertext, writeDecrypted, existingDecrypted } from '../lib/chatMediaFiles';
import type { AttachmentFile, AttachmentFs } from '../lib/saveAttachment';
import { chatMediaCacheFilename, chatMediaCiphertextFilename, chatMediaFilename } from '../lib/chatMedia';

const MEDIA_ID = 'a'.repeat(32);
const SPEC = {
  url: `https://openstoa.local/api/topics/t/chat/media?key=k`,
  headers: { Authorization: 'Bearer jwt' },
};

/**
 * A filesystem whose REFUSALS match the real one's.
 *
 * `expo-file-system`'s `downloadFileAsync` rejects on a non-2xx rather than
 * writing the error page to the file, and `File.write` takes bytes. A double
 * that accepted either would certify a broken path as working — which is the
 * dominant way tests have lied in this codebase.
 */
function harness(
  over: {
    downloadFails?: boolean;
    readFails?: boolean;
    writeFails?: boolean;
    deleteFails?: boolean;
    content?: Uint8Array;
  } = {},
) {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>();

  const makeFile = (name: string): AttachmentFile => ({
    uri: `file:///caches/${name}`,
    write: vi.fn((content: Uint8Array) => {
      if (!(content instanceof Uint8Array)) {
        throw new TypeError(`write expects bytes, got ${typeof content}`);
      }
      if (over.writeFails) throw new Error('disk full');
      calls.push(`write:${name}`);
      files.set(name, content);
    }),
    bytes: vi.fn(async () => {
      if (over.readFails) throw new Error('unreadable');
      calls.push(`bytes:${name}`);
      return files.get(name) ?? new Uint8Array(0);
    }),
    delete: vi.fn(() => {
      calls.push(`delete:${name}`);
      if (over.deleteFails) throw new Error('gone already');
      files.delete(name);
    }),
    /*
     * Is the plaintext already here? This is what makes "decrypt once" true —
     * `existingDecrypted` asks it before anything is fetched or decrypted.
     * Backed by the same `files` map the writes go into, so a test that writes
     * and then looks is exercising the real relationship, not a stub.
     */
    get exists() {
      return files.has(name);
    },
  });

  const downloaded: Array<{ url: string; name: string; headers: Record<string, string> }> = [];
  const fs: AttachmentFs = {
    cacheFile: vi.fn((name: string) => makeFile(name)),
    download: vi.fn(async (url: string, name: string, headers: Record<string, string>) => {
      downloaded.push({ url, name, headers });
      // The real one rejects on a non-2xx; it does not hand back a file
      // containing an error page.
      if (over.downloadFails) throw new Error('UnableToDownload: 403');
      calls.push(`download:${name}`);
      files.set(name, over.content ?? new Uint8Array([9, 9, 9]));
      return makeFile(name);
    }),
  };

  return { fs, calls, downloaded, files };
}

describe('downloadCiphertext', () => {
  it('CONTRACT: fetches through the gated URL with the credential, and returns the bytes', async () => {
    const h = harness({ content: new Uint8Array([1, 2, 3]) });
    const bytes = await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID });

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(h.downloaded).toHaveLength(1);
    expect(h.downloaded[0].url).toBe(SPEC.url);
    expect(h.downloaded[0].headers).toEqual(SPEC.headers);
  });

  it('CONTRACT: the response never crosses the bridge as a string', async () => {
    /*
     * The whole point. A regression to `fetch(...).json()` + `base64ToBytes`
     * would still return the right bytes and pass everything above, so what is
     * pinned is that the download goes through the FILESYSTEM at all.
     */
    const h = harness();
    await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID });
    expect(h.fs.download).toHaveBeenCalledTimes(1);
  });

  it('INTEGRITY: bytes no base64 alphabet contains survive', async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x80, 0x0a, 0x7f]);
    const h = harness({ content: raw });
    expect(Array.from(await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID }))).toEqual(
      Array.from(raw),
    );
  });

  it('BOUNDARY: a single byte round-trips', async () => {
    const h = harness({ content: new Uint8Array([7]) });
    expect(Array.from(await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID }))).toEqual([7]);
  });

  it('INTEGRITY: the temporary ciphertext file is removed on success', async () => {
    // One file per picture opened, in a cache directory nobody would ever go
    // looking in, is a slow leak with no symptom until the disk is full.
    const h = harness();
    await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID });
    expect(h.calls).toContain(`delete:${chatMediaCiphertextFilename(MEDIA_ID)}`);
    expect(h.files.size).toBe(0);
  });

  it('INTEGRITY: it is removed when the READ fails too', async () => {
    const h = harness({ readFails: true });
    await expect(downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID })).rejects.toThrow();
    expect(h.calls).toContain(`delete:${chatMediaCiphertextFilename(MEDIA_ID)}`);
  });

  it('BOUNDARY: an empty download is a FETCH failure, not a decrypt failure', async () => {
    /*
     * The distinction is what the reader is told. `fetch-failed` says "try
     * again" and offers Reload; `decrypt-failed` says "these bytes are not what
     * the message claims, retrying will not help". Handing an empty buffer to
     * the decryptor would produce the second, final-sounding answer for a
     * situation that is entirely retryable.
     */
    const h = harness({ content: new Uint8Array(0) });
    await expect(downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID })).rejects.toThrow(
      /empty/i,
    );
  });

  it('EXTERNAL: a download that rejects surfaces as a throw', async () => {
    // `loadEncryptedChatMedia` maps a throw to `fetch-failed`, which is the
    // honest answer for a 403, a dead network and a collected object alike.
    const h = harness({ downloadFails: true });
    await expect(downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID })).rejects.toThrow();
    // Nothing landed, so nothing is deleted — and nothing is left behind.
    expect(h.calls.filter((c) => c.startsWith('delete:'))).toEqual([]);
  });

  it('EXTERNAL: a host with no filesystem module throws rather than returning nothing', async () => {
    /*
     * An older host binary. It must not resolve with an empty buffer: that
     * would reach the decryptor and be reported as `decrypt-failed`, telling
     * the reader their attachment is corrupt when the truth is that this build
     * cannot fetch it.
     */
    await expect(
      downloadCiphertext({ fs: null, spec: SPEC, mediaId: MEDIA_ID }),
    ).rejects.toThrow(/filesystem/i);
  });

  it('EXTERNAL: a delete that throws does not spoil a successful fetch', async () => {
    const h = harness({ deleteFails: true, content: new Uint8Array([4]) });
    expect(Array.from(await downloadCiphertext({ fs: h.fs, spec: SPEC, mediaId: MEDIA_ID }))).toEqual([4]);
  });
});

describe('writeDecrypted', () => {
  it('CONTRACT: writes the plaintext bytes and hands back a file:// URI', async () => {
    const h = harness();
    const file = writeDecrypted({
      fs: h.fs,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });

    expect(file).not.toBeNull();
    expect(file!.uri).toBe(`file:///caches/${chatMediaCacheFilename('image/png', MEDIA_ID)}`);
    expect(Array.from(h.files.get(chatMediaCacheFilename('image/png', MEDIA_ID))!)).toEqual([1, 2, 3]);
  });

  it('CONTRACT: no base64 — the bytes are written as bytes', () => {
    /*
     * The 694ms this change removes. A regression to `chatMediaDataUri` would
     * re-encode the plaintext to a multi-megabyte string on the JS thread and
     * keep it alive for as long as the row was on screen. The double throws on
     * anything that is not a Uint8Array, so this fails loudly rather than
     * writing a file of the wrong length.
     */
    const h = harness();
    const file = writeDecrypted({
      fs: h.fs,
      bytes: new Uint8Array([0x89, 0x50]),
      mime: 'image/png',
      mediaId: MEDIA_ID,
    });
    expect(file).not.toBeNull();
    const [content] = (file!.write as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(content).toBeInstanceOf(Uint8Array);
  });

  it('INTEGRITY: the display file is NOT the file a save writes', () => {
    /*
     * `saveAttachment` deletes its own copy once the share sheet closes. If the
     * two names collided, saving a picture would erase the picture on screen —
     * and only someone who pressed Save would ever see it.
     */
    expect(chatMediaCacheFilename('image/png', MEDIA_ID)).not.toBe(chatMediaFilename('image/png', MEDIA_ID));
  });

  it('HOSTILE: a mime from the sealed envelope cannot steer the filename', () => {
    // The mime was written by whichever member sent the message. If it reached
    // the path, they would be choosing what this device writes and where.
    const h = harness();
    writeDecrypted({ fs: h.fs, bytes: new Uint8Array([1]), mime: '../../../etc/passwd', mediaId: MEDIA_ID });
    const name = (h.fs.cacheFile as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
    expect(name.endsWith('.bin')).toBe(true);
  });

  it('HOSTILE: neither does a media id that is not the hex it should be', () => {
    const h = harness();
    writeDecrypted({ fs: h.fs, bytes: new Uint8Array([1]), mime: 'image/png', mediaId: '../../x/y' });
    const name = (h.fs.cacheFile as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('EXTERNAL: no filesystem module is null, not a throw', () => {
    // The bytes decrypted fine, so this is not an error state — it is a
    // "cannot display it here" state, and a throw would take the row with it.
    expect(writeDecrypted({ fs: null, bytes: new Uint8Array([1]), mime: 'image/png', mediaId: MEDIA_ID })).toBeNull();
  });

  it('EXTERNAL: a failed write is null, not a throw', () => {
    const h = harness({ writeFails: true });
    expect(
      writeDecrypted({ fs: h.fs, bytes: new Uint8Array([1]), mime: 'image/png', mediaId: MEDIA_ID }),
    ).toBeNull();
  });
});

describe('discardDecrypted', () => {
  it('deletes the file', () => {
    const h = harness();
    const file = writeDecrypted({ fs: h.fs, bytes: new Uint8Array([1]), mime: 'image/png', mediaId: MEDIA_ID });
    discardDecrypted(file);
    expect(h.files.size).toBe(0);
  });

  it('RACE: null, undefined and a delete that throws are all no-ops', () => {
    /*
     * It runs from a React cleanup — an unmount, or an envelope changing under
     * a row that is still loading — where a throw takes the unmount with it.
     * Every one of these happens: no file was written yet, the effect was
     * cancelled before the write, the OS already reclaimed the cache.
     */
    const h = harness({ deleteFails: true });
    expect(() => discardDecrypted(null)).not.toThrow();
    expect(() => discardDecrypted(undefined)).not.toThrow();
    const file = h.fs.cacheFile('x.png');
    expect(() => discardDecrypted(file)).not.toThrow();
  });
});

/**
 * A picture is decrypted ONCE, on a phone.
 *
 * The web's half of this rule keeps plaintext in IndexedDB; a phone has nowhere
 * to put a blob, so its half is the display FILE that `<Image>` already reads.
 * The file is named from the media id, so the name a second view would write is
 * the name the first view already wrote — which is the whole trick.
 *
 * WHAT THIS REPLACED. The room used to delete this file on unmount, on the
 * argument that decrypted plaintext from an end-to-end encrypted conversation
 * must not outlive the row. The file is in the app's own sandboxed cache and
 * the key that opens the ciphertext is on the same device, so anyone who can
 * read one can read the other: deleting it took no capability from an attacker
 * and made the owner pay 3,086ms of AES again on every re-entry (measured under
 * Hermes, 6MB attachment).
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → a file written earlier is found, and its uri is handed back
 *   contract   → nothing written means a miss, so the caller decrypts
 *   integrity  → the lookup name matches what `writeDecrypted` produced
 *   empty      → no filesystem at all is a miss, not a throw
 *   hostile    → a host whose file object predates `exists` is a miss
 *   external   → a filesystem that throws from `cacheFile` is a miss
 */
describe('existingDecrypted — a picture is decrypted once', () => {
  it('CONTRACT: finds what writeDecrypted put there, under the same name', () => {
    const h = harness();
    const written = writeDecrypted({
      fs: h.fs,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      mediaId: 'abc123',
    });
    expect(written).not.toBeNull();

    const found = existingDecrypted({ fs: h.fs, mime: 'image/png', mediaId: 'abc123' });
    expect(found).not.toBeNull();
    // The same file, so `<Image>` reads the bytes that are already on disk.
    expect(found!.uri).toBe(written!.uri);
  });

  it('CONTRACT: nothing written is a miss, so the caller decrypts', () => {
    const h = harness();
    expect(existingDecrypted({ fs: h.fs, mime: 'image/png', mediaId: 'never' })).toBeNull();
  });

  it('INTEGRITY: a different mime looks somewhere else, and misses', () => {
    const h = harness();
    writeDecrypted({ fs: h.fs, bytes: new Uint8Array([1]), mime: 'image/png', mediaId: 'm1' });
    // The suffix is part of the name, so a row claiming a different type cannot
    // be served the png — the same reason the web checks mime on its rows.
    expect(existingDecrypted({ fs: h.fs, mime: 'image/jpeg', mediaId: 'm1' })).toBeNull();
  });

  it('EMPTY: no filesystem at all is a miss, not a throw', () => {
    expect(existingDecrypted({ fs: null, mime: 'image/png', mediaId: 'm1' })).toBeNull();
  });

  it('HOSTILE: a host binary whose file object predates `exists` is a miss', () => {
    const h = harness();
    // The mini-app borrows this object from the host app, so an older host
    // hands back a file with no `exists`. A required member would crash on the
    // one path the cache exists to make faster.
    const legacy: AttachmentFs = {
      ...h.fs,
      cacheFile: (name: string) => {
        // Spread, then blank `exists` — the older host's object simply does not
        // have the member, and `undefined` is how that reaches this code.
        const file = h.fs.cacheFile(name);
        return { ...file, exists: undefined };
      },
    };
    expect(existingDecrypted({ fs: legacy, mime: 'image/png', mediaId: 'm1' })).toBeNull();
  });

  it('EXTERNAL FAILURE: a filesystem that throws is a miss, never the reason a picture fails', () => {
    const broken: AttachmentFs = {
      cacheFile: () => {
        throw new Error('no cache directory');
      },
      download: async () => {
        throw new Error('unused');
      },
    };
    expect(existingDecrypted({ fs: broken, mime: 'image/png', mediaId: 'm1' })).toBeNull();
  });
});
