/**
 * Signing out on the web erases everything that can read a conversation.
 *
 * THE DEFECT. Logout cleared the session cookie and stopped. The MLS
 * ClientState stayed in IndexedDB, this browser's leaf identity in
 * `localStorage`, and the decrypted-picture cache — not ciphertext, the actual
 * images — on disk. Closing the browser changed none of it. On a library or
 * office machine the next person opens the same browser and reads the previous
 * person's end-to-end encrypted chat.
 *
 * WHY IT STILL MATTERS NOW THAT WEB CHAT IS GONE. Everyone who used chat before
 * today already has that material in their browser. Removing the feature does
 * not remove what it left behind, and signing out is the one moment we are
 * certain of being able to.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → every key-material prefix is removed; both databases deleted
 *   integrity  → preferences (theme, rail width, nav groups) SURVIVE — a wipe
 *                that feels like a factory reset gets turned off
 *   boundary   → 0 keys, 1 key, many keys, and a key whose name is a prefix of
 *                another
 *   hostile    → a key that merely CONTAINS a watched prefix later in the
 *                string is not removed (prefix, not substring)
 *   empty      → storage entirely absent does not throw
 *   external   → `localStorage.removeItem` throwing, `indexedDB` missing, and a
 *                delete that reports `blocked` because another tab holds it
 *   race       → removal does not skip entries by re-indexing while iterating
 *   contract   → the logout handler actually CALLS it (a wipe nobody invokes is
 *                the same defect with more code)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wipeLocalKeys, isKeyMaterialKey, KEPT_PREFIXES } from '@/lib/mls/wipeLocalKeys';

/** A `localStorage` stand-in that can be made to misbehave. */
class MemStorage {
  map = new Map<string, string>();
  failRemoveFor: string | null = null;
  get length() {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.failRemoveFor === k) throw new Error('storage is full or locked');
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemStorage;
let deleted: string[];
let deleteBehaviour: 'success' | 'error' | 'blocked' | 'throw';

beforeEach(() => {
  storage = new MemStorage();
  deleted = [];
  deleteBehaviour = 'success';
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('indexedDB', {
    deleteDatabase(name: string) {
      deleted.push(name);
      const req: Record<string, unknown> = {};
      if (deleteBehaviour === 'throw') throw new Error('private mode');
      queueMicrotask(() => {
        const handler =
          deleteBehaviour === 'success'
            ? req.onsuccess
            : deleteBehaviour === 'error'
              ? req.onerror
              : req.onblocked;
        (handler as (() => void) | undefined)?.();
      });
      return req;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what counts as key material', () => {
  it('CONTRACT: every store that can read a room is watched', () => {
    for (const key of [
      'openstoa.mls.device',
      'openstoa.mls.state.topic-1',
      'openstoa.tak.root.t1',
      'openstoa.masterKey',
      'openstoa.keychain.t1.epoch3',
      'openstoa.session',
      'openstoa.recoveryNudge.dismissed',
    ]) {
      expect(isKeyMaterialKey(key), key).toBe(true);
    }
  });

  it('INTEGRITY: preferences are NOT key material', () => {
    // A sign-out that also resets the theme and the layout reads as a factory
    // reset, and a factory reset is a thing people avoid doing.
    for (const kept of KEPT_PREFIXES) {
      expect(isKeyMaterialKey(kept), kept).toBe(false);
    }
  });

  it('HOSTILE: a prefix must be at the START, not anywhere in the name', () => {
    // `theirapp.openstoa.mls.x` belongs to something else entirely.
    expect(isKeyMaterialKey('theirapp.openstoa.mls.x')).toBe(false);
    expect(isKeyMaterialKey('x-openstoa.tak.root')).toBe(false);
  });

  it('BOUNDARY: a name that is a prefix of a watched one is not itself watched', () => {
    expect(isKeyMaterialKey('openstoa.ml')).toBe(false);
    expect(isKeyMaterialKey('openstoa.')).toBe(false);
  });
});

describe('wiping', () => {
  it('BOUNDARY: nothing stored is not an error', async () => {
    await expect(wipeLocalKeys()).resolves.toBeUndefined();
    expect(storage.map.size).toBe(0);
  });

  it('BOUNDARY: one key', async () => {
    storage.setItem('openstoa.masterKey', 'secret');
    await wipeLocalKeys();
    expect(storage.map.size).toBe(0);
  });

  it('RACE: many keys all go — removal does not skip every second one', async () => {
    /*
     * The bug this guards: removing while iterating by index re-indexes the
     * store, so a naive loop deletes the 1st, 3rd, 5th… and leaves half the
     * epoch keys behind — on a shared machine, silently.
     */
    for (let i = 0; i < 20; i += 1) storage.setItem(`openstoa.keychain.t${i}`, 'k');
    await wipeLocalKeys();
    expect(storage.map.size).toBe(0);
  });

  it('INTEGRITY: preferences survive alongside a full wipe', async () => {
    storage.setItem('openstoa.theme', 'dark');
    storage.setItem('openstoa.chatRail.width', '320');
    storage.setItem('openstoa.leftNav.groups', '{"browse":true}');
    storage.setItem('openstoa.mls.device', 'leaf');
    storage.setItem('openstoa.masterKey', 'secret');

    await wipeLocalKeys();

    expect([...storage.map.keys()].sort()).toEqual([
      'openstoa.chatRail.width',
      'openstoa.leftNav.groups',
      'openstoa.theme',
    ]);
  });

  it('CONTRACT: both databases are deleted', async () => {
    await wipeLocalKeys();
    expect(deleted.sort()).toEqual(['openstoa-chat-media', 'openstoa-mls']);
  });

  it('EXTERNAL: one stubborn key does not strand the others', async () => {
    storage.setItem('openstoa.mls.device', 'leaf');
    storage.setItem('openstoa.masterKey', 'secret');
    storage.failRemoveFor = 'openstoa.mls.device';

    await wipeLocalKeys();

    // The one that could be removed was.
    expect(storage.getItem('openstoa.masterKey')).toBeNull();
  });

  it('EXTERNAL: a delete that errors resolves rather than hanging', async () => {
    deleteBehaviour = 'error';
    await expect(wipeLocalKeys()).resolves.toBeUndefined();
  });

  it('EXTERNAL: `blocked` — another tab holds the database — resolves too', async () => {
    // Sign-out must not stall behind a window the person forgot about. The
    // delete stays queued and lands when that tab closes.
    deleteBehaviour = 'blocked';
    await expect(wipeLocalKeys()).resolves.toBeUndefined();
  });

  it('EXTERNAL: private mode, where the call itself throws', async () => {
    deleteBehaviour = 'throw';
    await expect(wipeLocalKeys()).resolves.toBeUndefined();
  });

  it('EMPTY: no storage at all (SSR / a browser with it disabled)', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('indexedDB', undefined);
    await expect(wipeLocalKeys()).resolves.toBeUndefined();
  });
});

describe('the logout handler calls it', () => {
  it('CONTRACT: /my calls wipeLocalKeys, and AWAITS it', () => {
    /*
     * A wipe nobody invokes is the original defect with more code in the tree.
     * Read at source because the alternative — driving the settings page in
     * jsdom — proves the button works in a test, not that the wiring is there.
     *
     * The `await` is asserted separately: the redirect that follows can tear
     * the page down mid-delete, and a half-wiped store is worse than an
     * untouched one because it looks clean.
     */
    const page = readFileSync(join(process.cwd(), 'src/app/my/page.tsx'), 'utf8');
    expect(page).toContain("from '@/lib/mls/wipeLocalKeys'");
    expect(page).toContain('await wipeLocalKeys();');

    const wipeAt = page.indexOf('await wipeLocalKeys();');
    const pushAt = page.indexOf("router.push('/')", wipeAt);
    expect(wipeAt, 'wipeLocalKeys is not called in handleLogout').toBeGreaterThan(-1);
    expect(pushAt, 'the wipe must happen BEFORE the redirect').toBeGreaterThan(wipeAt);
  });
});
