/**
 * How much of this phone OpenStoa is using, split into what a clear would take
 * and what it would keep.
 *
 * WHY A NUMBER AT ALL. "Clear cache" with no size is a button somebody presses
 * hopefully. The reason to press it is storage, so the screen has to say how
 * much there is — and, just as importantly, how much would remain, because a
 * clear that frees 4 MB out of 300 MB is worth knowing about BEFORE tapping.
 *
 * IT IS A MEASUREMENT, NOT AN ESTIMATE. Every value is read and its length
 * taken; nothing is extrapolated from a key count. The cost is one read per key,
 * which is why this runs when the screen opens and not on every render.
 *
 * BYTES, NOT CHARACTERS. A stored value is UTF-8 on disk, so a Korean message
 * occupies three bytes per character and `String.length` would under-report it
 * by a factor of three — on a Korean-language app, systematically. `byteLength`
 * is the honest measure.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: reach into the secure store. The Keychain
 * cannot be enumerated (the reason `tak.manifest` exists at all), so any figure
 * for it would be a guess dressed as a measurement — and it is the part a clear
 * never touches anyway, so the number would not inform the decision.
 */

import { keyVerdict, type EraseScope } from './deviceData';

/** The stores this can read. Same shapes `eraseDeviceData` takes. */
export interface SizeDeps {
  local?: {
    getItem(key: string): Promise<string | null>;
    getAllKeys?(): Promise<string[]>;
  } | null;
  fs?: {
    listCache?(): Promise<string[]>;
    /**
     * Bytes for one cache file.
     *
     * Separate from `cacheFile` because measuring must not be able to delete:
     * handing the measurement a handle with `delete()` on it would make a
     * mis-wired call destructive, and this runs when a SCREEN OPENS.
     *
     * `expo-file-system@19`'s `File.size` is a synchronous property that answers
     * 0 for a file that does not exist or cannot be read — so a missing file
     * costs nothing and reports nothing, which is the behaviour wanted here.
     */
    cacheFileSize?(name: string): Promise<number>;
  } | null;
}

export interface DeviceDataSize {
  /** Bytes a clear at this scope would remove from the key-value store. */
  eraseBytes: number;
  /** Bytes it would leave behind. */
  keepBytes: number;
  /** Number of keys in each half, for the "what stays" explanation. */
  eraseKeys: number;
  keepKeys: number;
  /** Media bytes, and how many files. */
  mediaBytes: number;
  mediaFiles: number;
  /**
   * What could not be measured, named rather than folded into a zero.
   *
   * A zero that means "nothing there" and a zero that means "could not look" are
   * different sentences on screen, and showing the second as the first is how a
   * person concludes there is nothing to clear.
   */
  gaps: SizeGap[];
}

export type SizeGap =
  /** No local store on this host build. */
  | 'local-absent'
  /** The store cannot enumerate, so its contents are unknown. */
  | 'local-unlistable'
  /** No filesystem, or it cannot list the cache directory. */
  | 'media-unlistable'
  /** The filesystem can list but cannot report sizes. */
  | 'media-unsizable';

/** UTF-8 bytes, not characters. See the header. */
function byteLength(v: string): number {
  // `Buffer` is not available in the mini-app runtime; `TextEncoder` is, and RN
  // polyfills it. Falling back to `length` would silently under-report Korean by
  // 3×, so a missing encoder is an explicit 0-contribution rather than a wrong
  // number... except there is no such runtime, so this is a straight call.
  return new TextEncoder().encode(v).length;
}

/**
 * Measure. Never throws — the caller is a screen, and a size that cannot be read
 * is a gap to name, not an error to raise.
 */
export async function measureDeviceData(
  deps: SizeDeps,
  scope: EraseScope,
): Promise<DeviceDataSize> {
  const out: DeviceDataSize = {
    eraseBytes: 0,
    keepBytes: 0,
    eraseKeys: 0,
    keepKeys: 0,
    mediaBytes: 0,
    mediaFiles: 0,
    gaps: [],
  };
  const gap = (g: SizeGap) => {
    if (!out.gaps.includes(g)) out.gaps.push(g);
  };

  await measureLocal(deps.local, scope, out, gap);
  await measureMedia(deps.fs, out, gap);
  return out;
}

async function measureLocal(
  local: SizeDeps['local'],
  scope: EraseScope,
  out: DeviceDataSize,
  gap: (g: SizeGap) => void,
): Promise<void> {
  if (!local) return gap('local-absent');
  if (!local.getAllKeys) return gap('local-unlistable');

  let keys: readonly string[];
  try {
    keys = await local.getAllKeys();
  } catch {
    return gap('local-unlistable');
  }
  if (!Array.isArray(keys)) return gap('local-unlistable');

  for (const k of keys) {
    // A store shared with the host can hold anything; a non-string key is not
    // ours to measure and not ours to classify.
    if (typeof k !== 'string') continue;

    let value: string | null = null;
    try {
      value = await local.getItem(k);
    } catch {
      /*
       * One unreadable value is not a reason to abandon the total — but it IS a
       * reason not to count it, and counting the key without its bytes would
       * make "0 bytes across 40 keys" look like a measurement.
       */
      continue;
    }
    if (typeof value !== 'string') continue;

    const bytes = byteLength(value);
    if (keyVerdict(k, scope) === 'erase') {
      out.eraseBytes += bytes;
      out.eraseKeys += 1;
    } else {
      out.keepBytes += bytes;
      out.keepKeys += 1;
    }
  }
}

async function measureMedia(
  fs: SizeDeps['fs'],
  out: DeviceDataSize,
  gap: (g: SizeGap) => void,
): Promise<void> {
  if (!fs?.listCache) return gap('media-unlistable');

  let names: readonly string[];
  try {
    names = await fs.listCache();
  } catch {
    return gap('media-unlistable');
  }
  if (!Array.isArray(names)) return gap('media-unlistable');

  const ours = names.filter((n) => typeof n === 'string' && isOurMedia(n));
  out.mediaFiles = ours.length;

  if (!fs.cacheFileSize) {
    // The count is real; the byte figure is not available. Say so rather than
    // reporting 0 bytes for 200 files.
    if (ours.length > 0) gap('media-unsizable');
    return;
  }

  for (const n of ours) {
    try {
      const size = await fs.cacheFileSize(n);
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) out.mediaBytes += size;
    } catch {
      gap('media-unsizable');
    }
  }
}

/**
 * Is this cache file ours?
 *
 * The cache directory belongs to the OS and holds other apps' — and the host
 * app's — files. Measuring those would inflate the number the person is shown
 * and, worse, imply this screen could delete them.
 *
 * The two shapes come from `chatMedia.ts`: `openstoa-<id>.enc` (ciphertext) and
 * `openstoa-view-<id>.<ext>` (the decrypted copy handed to the image view).
 */
function isOurMedia(name: string): boolean {
  return name.startsWith('openstoa-');
}

/**
 * Bytes as a person reads them.
 *
 * Binary units against a 1024 divisor, matching what a phone's own storage
 * screen shows — a figure that disagreed with Settings would read as wrong even
 * when it was right. One decimal below 10 units, none above: "9.4 MB" is useful,
 * "94.7 MB" is noise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  // Under 0.1 KB still says "0.1 KB" rather than "0 KB": something is there, and
  // a zero would tell the person there is nothing to clear.
  if (v < 0.1) return `0.1 ${units[u]}`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
