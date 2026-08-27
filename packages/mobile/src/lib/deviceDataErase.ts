/**
 * Applying a decision from `deviceData.ts` to the stores that hold the data.
 *
 * SEPARATE FROM THE DECISION so the decision can be tested without a store and
 * this can be tested without a device. Everything it touches arrives as a
 * parameter; it imports no host, no React, and no native module.
 *
 * ── The capability problem, which is the whole reason this file is shaped
 *    the way it is ────────────────────────────────────────────────────────────
 *
 * The mini-app does not own its storage. It borrows the host's through
 * `HostApi.localStore` / `HostApi.secureStore`, and until now that bridge
 * offered exactly two operations: `getItem` and `setItem`. Neither of them can
 * delete anything, and neither can say what is there.
 *
 * That is not an oversight to route around. It is a fact about the OS:
 *
 *   - AsyncStorage CAN enumerate (`getAllKeys`) and CAN delete (`removeItem`),
 *     so the local store's gap is only that the bridge never exposed it.
 *   - The Keychain / Keystore CANNOT enumerate, on any version, by design.
 *     That is why `takSession` keeps a manifest of its own keys at all, and it
 *     is why a full erase has to NAME every secure key it removes rather than
 *     sweep (see `deviceData.secureEraseKeys`).
 *
 * So the bridge gains OPTIONAL `removeItem` / `getAllKeys`, and this file
 * reports what it could not do instead of pretending. A host binary that
 * predates them makes the feature UNAVAILABLE, visibly — not silently
 * successful, which for an "erase everything" button is the worst possible
 * failure: the person believes their keys are gone and they are not.
 *
 * ── Nothing here aborts on the first failure ───────────────────────────────
 *
 * A key that will not delete is counted and skipped. Stopping would leave the
 * device in the one state nobody asked for — half erased — and would make the
 * outcome depend on the order the store happened to enumerate in.
 */
import {
  type EraseScope,
  isMediaCacheFile,
  planKeys,
} from './deviceData';

/** The slice of a host store this needs. Removal and listing are optional. */
export interface ErasableStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /** Absent on a host binary that predates the erase feature. */
  removeItem?(key: string): Promise<void>;
  /** Absent on the Keychain always, and on older hosts for AsyncStorage. */
  getAllKeys?(): Promise<string[]>;
}

/** The slice of the host filesystem this needs, all of it optional. */
export interface ErasableCacheFs {
  /** Names of the files in the shared OS cache directory. */
  listCache?(): Promise<string[]>;
  cacheFile(name: string): { delete(): void };
}

/**
 * Something the erase could not do, named so the screen can say it.
 *
 * There is no `unknown` member and there is no silent path. Every branch below
 * either deletes or records one of these.
 */
export type EraseGap =
  /** No local store on this host — the message caches are in memory only. */
  | 'local-store-absent'
  /** The host cannot list its local keys, so the caches cannot be found. */
  | 'local-no-enumeration'
  /** The host cannot delete a local key. */
  | 'local-no-removal'
  /** No secure store on this host — there are no persisted keys to erase. */
  | 'secure-store-absent'
  /** The host cannot delete a Keychain entry, so the keys STAY. */
  | 'secure-no-removal'
  /** No filesystem module in this host binary — cached media is untouched. */
  | 'media-fs-absent'
  /** The filesystem cannot list the cache directory, so files cannot be found. */
  | 'media-no-listing'
  /** At least one delete was attempted and threw. `failed` says how many. */
  | 'some-deletes-failed'
  /*
   * The list of rooms could not be obtained, so the KEY LIST handed to this
   * function is incomplete and keys for unlisted rooms remain on the device.
   *
   * Every other value above describes a store that cannot do something. This
   * one describes an INPUT that was short, and it needs its own name because
   * the two are not the same sentence to the person reading the report: a
   * Keychain that refuses to delete is a broken phone, while an unlisted room
   * is a perfectly healthy phone that quietly kept a chat key.
   *
   * FOUND 2026-08-27, reading the code rather than watching it fail. Offline —
   * or an expired session — makes `/api/topics` throw; the screen logs a
   * `console.warn` and carries on with whatever the chat-list cache held. The
   * report then contained no gaps at all, which reads as "everything is gone".
   * For the one case this feature exists for — handing the phone to somebody
   * else — that sentence being wrong is the whole failure.
   */
  | 'topics-not-listed'
  /*
   * The archive keychain could not be enumerated, so archive keys it never
   * derived by name are still on the device.
   *
   * Separate from `topics-not-listed` because the two are different sentences
   * about what remains — a missing room list leaves that room's MLS state, an
   * unreadable manifest leaves archive roots for rooms that ARE listed — and
   * folding them into one value would make the report vaguer than the code's
   * actual knowledge.
   */
  | 'keychain-not-listed';

export interface EraseReport {
  scope: EraseScope;
  /** Local-store keys deleted. */
  localRemoved: number;
  /** Local-store keys deliberately left alone. The protected count. */
  localKept: number;
  /** Secure-store keys deleted. Always 0 under the `cache` scope. */
  secureRemoved: number;
  /** Cached media files deleted. */
  mediaRemoved: number;
  /** Deletes that threw. Counted, never fatal. */
  failed: number;
  /** Everything that could not be done. Empty means the erase was complete. */
  gaps: EraseGap[];
}

export interface EraseDeps {
  local?: ErasableStore | null;
  secure?: ErasableStore | null;
  fs?: ErasableCacheFs | null;
  /**
   * Secure keys to remove, from `deviceData.secureEraseKeys`.
   *
   * Passed in rather than derived here because deriving them needs the device
   * identity, the topic ids and the TAK manifest — three reads against three
   * different modules, none of which belong in a function whose job is to
   * delete what it is told to.
   *
   * MUST be empty for the `cache` scope. Asserted below rather than assumed:
   * a caller that got this wrong would erase the keychain while the person was
   * told they were clearing a cache.
   */
  secureKeys?: readonly string[];
}

/**
 * Delete what `scope` allows, and report what could not be deleted.
 *
 * NEVER THROWS. The caller is a button; a rejection here would show a red error
 * over an erase that mostly succeeded, and would tell the person nothing about
 * which half.
 */
export async function eraseDeviceData(
  deps: EraseDeps,
  scope: EraseScope,
  /*
   * Gaps the CALLER already knows about, folded into the same report.
   *
   * The caller is the only one who can know these: it builds the key list, so
   * only it can tell that the list came up short. Returning them separately
   * would let a screen render a complete-looking report and drop them, which is
   * exactly what happened before this parameter existed.
   */
  knownGaps: readonly EraseGap[] = [],
): Promise<EraseReport> {
  const report: EraseReport = {
    scope,
    localRemoved: 0,
    localKept: 0,
    secureRemoved: 0,
    mediaRemoved: 0,
    failed: 0,
    gaps: [],
  };
  const gap = (g: EraseGap) => {
    if (!report.gaps.includes(g)) report.gaps.push(g);
  };
  // Before anything is deleted, so a caller's gap survives even if a store
  // below throws its way out of the rest of the run.
  for (const g of knownGaps) gap(g);

  await eraseLocal(deps.local, scope, report, gap);
  await eraseSecure(deps.secure, scope, deps.secureKeys ?? [], report, gap);
  await eraseMedia(deps.fs, report, gap);

  return report;
}

async function eraseLocal(
  local: ErasableStore | null | undefined,
  scope: EraseScope,
  report: EraseReport,
  gap: (g: EraseGap) => void,
): Promise<void> {
  if (!local) return gap('local-store-absent');
  if (typeof local.getAllKeys !== 'function') return gap('local-no-enumeration');
  if (typeof local.removeItem !== 'function') return gap('local-no-removal');

  let keys: string[];
  try {
    keys = await local.getAllKeys();
  } catch {
    /*
     * A store that cannot be listed is indistinguishable from one with nothing
     * in it, and the two must NOT be reported the same way. "I found nothing"
     * would read as a completed erase.
     */
    return gap('local-no-enumeration');
  }
  if (!Array.isArray(keys)) return gap('local-no-enumeration');

  const { erase, keep } = planKeys(keys.filter((k) => typeof k === 'string'), scope);
  report.localKept = keep.length;

  for (const k of erase) {
    try {
      await local.removeItem(k);
      report.localRemoved += 1;
    } catch {
      report.failed += 1;
      gap('some-deletes-failed');
    }
  }
}

async function eraseSecure(
  secure: ErasableStore | null | undefined,
  scope: EraseScope,
  secureKeys: readonly string[],
  report: EraseReport,
  gap: (g: EraseGap) => void,
): Promise<void> {
  /*
   * A cache clear touches NOTHING in the Keychain.
   *
   * Not "touches nothing it should not" — nothing at all. Every secure key is
   * either a group state, an archive key, or the master key that opens both,
   * and none of them is re-downloadable. The scope check is here, at the door,
   * as well as in `keyVerdict`, so a caller that passed keys by mistake cannot
   * reach the store.
   */
  if (scope !== 'device') return;
  if (!secure) return gap('secure-store-absent');
  if (typeof secure.removeItem !== 'function') return gap('secure-no-removal');

  for (const k of secureKeys) {
    try {
      await secure.removeItem(k);
      report.secureRemoved += 1;
    } catch {
      report.failed += 1;
      gap('some-deletes-failed');
    }
  }
}

async function eraseMedia(
  fs: ErasableCacheFs | null | undefined,
  report: EraseReport,
  gap: (g: EraseGap) => void,
): Promise<void> {
  /*
   * Media is a cache under BOTH scopes. The bytes are on the server and the key
   * that opens them is in the archive keychain, so deleting a picture file
   * costs one re-download and never costs history.
   */
  if (!fs) return gap('media-fs-absent');
  if (typeof fs.listCache !== 'function') return gap('media-no-listing');

  let names: string[];
  try {
    names = await fs.listCache();
  } catch {
    return gap('media-no-listing');
  }
  if (!Array.isArray(names)) return gap('media-no-listing');

  for (const name of names) {
    if (!isMediaCacheFile(name)) continue;
    try {
      fs.cacheFile(name).delete();
      report.mediaRemoved += 1;
    } catch {
      /*
       * A file that vanished between the listing and the delete is the normal
       * case, not a failure — the OS reclaims this directory whenever it likes,
       * and `chatMediaFiles` writes into it from another task. Counted anyway,
       * because a report that hid it would make a permissions problem look
       * identical to a tidy cache.
       */
      report.failed += 1;
      gap('some-deletes-failed');
    }
  }
}

/**
 * Did everything the person was promised actually happen?
 *
 * `some-deletes-failed` is included: a full erase that left keys behind has not
 * erased the device, and saying so is the difference between a warning and a
 * lie.
 */
export function eraseWasComplete(report: EraseReport): boolean {
  return report.gaps.length === 0;
}

/**
 * Gaps that mean the action could not run AT ALL on this host binary.
 *
 * Distinguished from a partial run because the two need different words. "Your
 * phone's app version cannot do this" is actionable; "some items could not be
 * removed" is not, and showing the second when the first is true sends people
 * to support with the wrong question.
 */
const BLOCKING: readonly EraseGap[] = [
  'local-no-enumeration',
  'local-no-removal',
  'secure-no-removal',
];

export function eraseWasBlocked(report: EraseReport): boolean {
  return report.gaps.some((g) => BLOCKING.includes(g));
}
