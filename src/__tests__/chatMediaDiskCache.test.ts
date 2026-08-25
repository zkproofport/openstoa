// @vitest-environment jsdom
/**
 * A picture is decrypted ONCE.
 *
 * WHAT THIS IS FOR. Every entry into a room used to re-fetch each attachment's
 * ciphertext and run AES over it again — measured under Hermes on a 6MB
 * attachment at 179ms to fetch and 3,086ms to decrypt, per picture, per entry.
 * A room with ten photos paid that ten times on every open, for bytes that had
 * not changed since the last time. This store holds the plaintext of anything
 * this device has already opened, so the second view costs a lookup.
 *
 * WHY IT MAY BE KEPT, since the mini-app's twin of this decision used to argue
 * the opposite and discard the plaintext on unmount. The store is origin-scoped
 * IndexedDB, and the key that opens the ciphertext lives in the same origin's
 * storage. Anyone who can read this database can read that key and decrypt the
 * archive themselves, so discarding the picture removed no capability from them
 * — it only made the honest reader pay AES again. What end-to-end encryption
 * protects is the picture in transit and at rest ON THE SERVER, and a row here
 * changes neither.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a write is readable, byte-for-byte
 *   contract   → a miss is null, never a throw
 *   integrity  → a row whose SIZE disagrees with the envelope is a miss
 *   integrity  → a row whose MIME disagrees with the envelope is a miss
 *   boundary   → a one-byte picture round-trips
 *   boundary   → the budget is stated in BYTES, since one entry can be megabytes
 *   hostile    → ids carrying wildcards, quotes, paths, Korean and emoji do not
 *                collide with each other or with an ordinary id
 *   external   → no IndexedDB at all, and a database that refuses to open
 *   race       → two writers for one id leave one readable row
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  cacheChatMedia,
  readCachedChatMedia,
  __resetChatMediaDiskCache,
  CHAT_MEDIA_DISK_BUDGET_BYTES,
} from '../lib/chatMediaDiskCache';

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

beforeEach(async () => {
  __resetChatMediaDiskCache();
  // A fresh database per case: `fake-indexeddb/auto` keeps one per process, so
  // without this a later case reads an earlier one's rows.
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('openstoa-chat-media');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  __resetChatMediaDiskCache();
});

describe('a picture is decrypted once', () => {
  it('CONTRACT: what was written comes back byte-for-byte', async () => {
    const written = bytes(1024, 42);
    await cacheChatMedia('a1', written, 'image/jpeg');

    const hit = await readCachedChatMedia('a1', 1024, 'image/jpeg');
    expect(hit).not.toBeNull();
    expect(hit!.mime).toBe('image/jpeg');
    expect(Array.from(hit!.bytes)).toEqual(Array.from(written));
  });

  it('CONTRACT: a picture never opened on this device is a miss, not a throw', async () => {
    await expect(readCachedChatMedia('never', 10, 'image/png')).resolves.toBeNull();
  });

  it('INTEGRITY: a row whose size disagrees with the envelope is a miss', async () => {
    await cacheChatMedia('a2', bytes(100), 'image/png');
    /*
     * The envelope for this bubble says 200 bytes. Serving the 100-byte row
     * would render something other than what the row claims — a cache that can
     * lie about its contents is worse than one that is slow.
     */
    expect(await readCachedChatMedia('a2', 200, 'image/png')).toBeNull();
  });

  it('INTEGRITY: a row whose mime disagrees with the envelope is a miss', async () => {
    await cacheChatMedia('a3', bytes(100), 'image/png');
    expect(await readCachedChatMedia('a3', 100, 'image/jpeg')).toBeNull();
  });

  it('BOUNDARY: a one-byte picture round-trips', async () => {
    await cacheChatMedia('tiny', bytes(1, 255), 'image/gif');
    const hit = await readCachedChatMedia('tiny', 1, 'image/gif');
    expect(hit?.bytes.byteLength).toBe(1);
  });

  it.each([
    ['wildcards', 'a%_b'],
    ['a quote', "it's"],
    ['a path traversal', '../../etc/passwd'],
    ['Korean', '사진-아이디'],
    ['emoji', '📷-1'],
    ['a very long id', 'z'.repeat(512)],
  ])(
    'HOSTILE: an id containing %s is stored under itself and collides with nothing',
    async (_label, id) => {
      await cacheChatMedia(id, bytes(8, 1), 'image/png');
      await cacheChatMedia('plain', bytes(8, 2), 'image/png');

      const mine = await readCachedChatMedia(id, 8, 'image/png');
      const other = await readCachedChatMedia('plain', 8, 'image/png');
      expect(mine?.bytes[0]).toBe(1);
      expect(other?.bytes[0]).toBe(2);
    },
  );

  it('RACE: two writers for one id leave one readable row', async () => {
    await Promise.all([
      cacheChatMedia('dup', bytes(16, 3), 'image/png'),
      cacheChatMedia('dup', bytes(16, 3), 'image/png'),
    ]);
    const hit = await readCachedChatMedia('dup', 16, 'image/png');
    expect(hit?.bytes.byteLength).toBe(16);
  });

  it('EXTERNAL FAILURE: no IndexedDB at all is a miss, never a throw', async () => {
    const real = globalThis.indexedDB;
    // Hardened browsers and some private modes: the global is simply absent.
    // @ts-expect-error — removing a global for the duration of one case.
    delete globalThis.indexedDB;
    __resetChatMediaDiskCache();
    try {
      await expect(readCachedChatMedia('x', 1, 'image/png')).resolves.toBeNull();
      // A write must not throw either — the picture is already on screen.
      await expect(cacheChatMedia('x', bytes(1), 'image/png')).resolves.toBeUndefined();
    } finally {
      globalThis.indexedDB = real;
      __resetChatMediaDiskCache();
    }
  });

  it('EXTERNAL FAILURE: a database that refuses to open is a miss', async () => {
    // Safari in private mode throws from `open` itself rather than erroring.
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('private mode');
    });
    __resetChatMediaDiskCache();
    try {
      await expect(readCachedChatMedia('y', 1, 'image/png')).resolves.toBeNull();
    } finally {
      open.mockRestore();
      __resetChatMediaDiskCache();
    }
  });

  it('BOUNDARY: the budget is stated in bytes, because one entry can be megabytes', () => {
    // A count bounds nothing useful when a single attachment may be several MB.
    expect(CHAT_MEDIA_DISK_BUDGET_BYTES).toBeGreaterThan(64 * 1024 * 1024);
  });
});
