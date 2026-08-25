/**
 * The plaintext of an attachment this device has ALREADY decrypted, kept on
 * disk so it is decrypted exactly once.
 *
 * THE WASTE THIS REMOVES. Every entry into a room re-fetched every picture's
 * ciphertext and ran AES over it again. Measured under Hermes on a 6MB
 * attachment: 179ms to fetch, 3,086ms to decrypt — per picture, per entry. A
 * room with ten photos paid that ten times, every single time it was opened,
 * for bytes that had not changed since the last time.
 *
 * `chatMediaPlaintextCache` next to this file does NOT cover it: that one is in
 * memory, holds only what THIS tab sent, and is gone on reload. This is the
 * other half — anything this device has ever opened, surviving a reload and a
 * restart.
 *
 * WHY KEEPING IT IS SAFE, since the mini-app's twin of this decision used to
 * argue the opposite and delete the plaintext on unmount. The store is
 * origin-scoped IndexedDB, and the key that opens the ciphertext is on the same
 * device, in the same origin's storage. Anyone who can read this database can
 * read that key and decrypt the whole archive themselves, so discarding the
 * picture took no capability away from them — it only made the honest reader
 * pay AES again. What end-to-end encryption protects is the picture in transit
 * and at rest ON THE SERVER; a cache entry here changes neither.
 *
 * NEVER AN ERROR. Every function degrades to "not cached": private-mode
 * browsers refuse IndexedDB, quota can be exhausted, and a corrupt store must
 * not be the reason a picture fails to appear. The reader path is still there
 * and still correct.
 */

const DB_NAME = 'openstoa-chat-media';
const DB_VERSION = 1;
const STORE = 'plaintext';

/**
 * Total bytes kept before the oldest entries are dropped.
 *
 * 256MB. Bounded in BYTES and not in entries because one entry can be several
 * megabytes, so a count bounds nothing useful. Eviction is by last USE rather
 * than by age of the message: the pictures worth keeping are the ones being
 * looked at, and a conversation being re-read is exactly the case this exists
 * for.
 */
export const CHAT_MEDIA_DISK_BUDGET_BYTES = 256 * 1024 * 1024;

interface CacheRow {
  /** The AEAD context id. Unique per attachment, already validated hex. */
  mediaId: string;
  bytes: Uint8Array;
  mime: string;
  /** Epoch ms of the last read or write. The eviction order. */
  usedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Safari in private mode throws from `open` itself rather than erroring.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'mediaId' });
        // The eviction scan reads this index rather than every row's bytes.
        store.createIndex('usedAt', 'usedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore | null {
  try {
    return db.transaction(STORE, mode).objectStore(STORE);
  } catch {
    return null;
  }
}

/**
 * The plaintext for `mediaId`, or null.
 *
 * `mime` and `size` are CHECKED, not merely returned: a row that disagrees with
 * the envelope describing this bubble is treated as a miss rather than
 * displayed. The id alone would be enough in practice — it is an AEAD context
 * id — but a cache that can render something other than what the row claims is
 * a cache that can lie, and this one is allowed to be slow instead.
 */
export async function readCachedChatMedia(
  mediaId: string,
  size: number,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const db = await openDb();
  if (!db) return null;
  const row = await new Promise<CacheRow | null>((resolve) => {
    const store = tx(db, 'readonly');
    if (!store) {
      resolve(null);
      return;
    }
    const req = store.get(mediaId);
    req.onsuccess = () => resolve((req.result as CacheRow | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
  if (!row || row.mime !== mime || row.bytes.byteLength !== size) return null;
  // Touch it so eviction drops what is not being looked at. Fire and forget:
  // a failed touch costs an early eviction, never a wrong picture.
  void new Promise<void>((resolve) => {
    const store = tx(db, 'readwrite');
    if (!store) {
      resolve();
      return;
    }
    const req = store.put({ ...row, usedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  return { bytes: row.bytes, mime: row.mime };
}

/** Keep `bytes` for next time. Never throws; a full disk is simply a miss later. */
export async function cacheChatMedia(
  mediaId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const store = tx(db, 'readwrite');
    if (!store) {
      resolve();
      return;
    }
    const req = store.put({ mediaId, bytes, mime, usedAt: Date.now() } satisfies CacheRow);
    req.onsuccess = () => resolve();
    // QuotaExceededError lands here. The picture is on screen either way.
    req.onerror = () => resolve();
  });
  void evictToBudget(db);
}

/**
 * Drop least-recently-used entries until the store is under budget.
 *
 * Walks the `usedAt` index oldest-first and deletes until the running total
 * fits. Reads every row to sum its bytes, which is the cost of bounding by
 * bytes rather than by count — it runs after a write, not on the read path.
 */
async function evictToBudget(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve) => {
    const store = tx(db, 'readwrite');
    if (!store) {
      resolve();
      return;
    }
    const rows: { mediaId: string; size: number; usedAt: number }[] = [];
    const req = store.index('usedAt').openCursor();
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const row = cursor.value as CacheRow;
        rows.push({ mediaId: row.mediaId, size: row.bytes.byteLength, usedAt: row.usedAt });
        cursor.continue();
        return;
      }
      let total = rows.reduce((sum, r) => sum + r.size, 0);
      // `rows` is already oldest-first: the index cursor walks ascending.
      for (const row of rows) {
        if (total <= CHAT_MEDIA_DISK_BUDGET_BYTES) break;
        total -= row.size;
        try {
          store.delete(row.mediaId);
        } catch {
          // Another transaction won. It will be evicted on the next write.
        }
      }
      resolve();
    };
  });
}

/**
 * Test seam. CLOSES the connection and drops the handle.
 *
 * Closing matters: an open connection blocks `deleteDatabase`, so a seam that
 * only dropped the reference left every later test waiting on a delete that
 * could never finish. It is also the honest meaning of "reset" — a leaked
 * connection is a leaked connection whether or not a test noticed.
 */
export function __resetChatMediaDiskCache(): void {
  const pending = dbPromise;
  dbPromise = null;
  void pending?.then((db) => db?.close()).catch(() => {});
}
