/**
 * Erase everything this browser holds that can read a conversation.
 *
 * THE DEFECT THIS EXISTS FOR. Signing out cleared the session and nothing else.
 * The MLS ClientState — the actual per-topic keys — stayed in IndexedDB, the
 * device identity stayed in `localStorage`, and the decrypted-picture cache
 * stayed on disk. Closing the browser changed none of it. So on a shared
 * computer the next person could open the same browser and read the previous
 * person's end-to-end encrypted chat, pictures included.
 *
 * That is not a tidiness problem. The whole claim of these tiers is that the
 * operator cannot read a word; leaving the plaintext on a library PC makes the
 * claim true of the server and false of the place it actually matters.
 *
 * WHAT IS ERASED, and why each one has to go:
 *
 *   `openstoa-mls`          IndexedDB — the MLS ClientState per topic. Holds the
 *                           ratchet; whoever has it reads the room.
 *   `openstoa-chat-media`   IndexedDB — decrypted pictures, in the clear. The
 *                           newest and worst of them: not ciphertext, the image.
 *   `openstoa.mls.device`   localStorage — this browser's leaf identity. Left
 *                           behind, a second person's session reuses the first
 *                           person's leaf, which is wrong even before privacy.
 *   the TAK/keychain keys   localStorage — epoch keys for the archive.
 *
 * WHAT IS KEPT: theme, chat-rail width, left-nav groups. Preferences say
 * nothing about anyone's messages, and wiping them makes signing out feel like
 * a factory reset for no gain.
 *
 * NEVER THROWS. Sign-out must complete even if a store refuses — a browser that
 * blocks IndexedDB, a database another tab still holds open. Each step is
 * independent so one failure cannot leave the rest behind, and the caller does
 * not wait: a person pressing "sign out" gets the redirect either way.
 */

/** Databases whose entire contents are key material or plaintext. */
const DATABASES = ['openstoa-mls', 'openstoa-chat-media'] as const;

/**
 * `localStorage` keys to remove. Anything matching one of these prefixes goes.
 *
 * Prefixes rather than exact names because the keychain writes one entry per
 * topic and per epoch, and a list of exact names would fall behind the first
 * time a new one is added — silently, leaving keys on a shared machine.
 */
const KEY_PREFIXES = [
  'openstoa.mls.',
  'openstoa.tak.',
  'openstoa.masterKey',
  'openstoa.keychain.',
  'openstoa.session',
  'openstoa.recoveryNudge.',
] as const;

/** Preferences deliberately left alone — see the note above. */
export const KEPT_PREFIXES = ['openstoa.theme', 'openstoa.chatRail', 'openstoa.leftNav'] as const;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      // Private mode throws from the call itself rather than erroring.
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    /*
     * `blocked` fires when ANOTHER TAB still holds the database open, and the
     * delete then waits for that tab. Resolving here rather than hanging is
     * deliberate: sign-out must not stall behind a window the person forgot
     * about. The delete is still queued and lands when that tab closes.
     */
    request.onblocked = () => resolve();
  });
}

/** True for a key this wipe is responsible for. */
export function isKeyMaterialKey(key: string): boolean {
  return KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Wipe it all. Resolves when every step has finished or given up.
 *
 * Exported for the sign-out handler and for tests; there is no other caller and
 * there should not be — a partial wipe from somewhere else is worse than none,
 * because it looks like the machine is clean.
 */
export async function wipeLocalKeys(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      // Collect first: removing while iterating re-indexes the keys and skips
      // every second match, which would leave half the epoch keys behind.
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && isKeyMaterialKey(key)) doomed.push(key);
      }
      for (const key of doomed) {
        try {
          localStorage.removeItem(key);
        } catch {
          // Keep going: one stubborn key must not strand the others.
        }
      }
    }
  } catch {
    // Storage disabled entirely. Nothing was written either, so nothing is left.
  }

  await Promise.all(DATABASES.map(deleteDatabase));
}
