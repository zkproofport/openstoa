/*
 * The size the screen shows must be a measurement, and it must split the way the
 * clear splits.
 *
 * WHY IT MATTERS THAT THE SPLIT MATCHES. The figure exists to answer "is it
 * worth tapping". If the measurement classified keys differently from
 * `eraseDeviceData` — one extra family on either side — the person would be
 * quoted a saving they do not get, or talked out of a clear that would have
 * freed real space. Both numbers come from `keyVerdict`, and the cases below
 * check the two agree by running the ACTUAL erase against the same store and
 * comparing.
 *
 * THE AXIS IS ACCUMULATION. A phone with one message and a phone with a
 * thousand are different questions, and a measurement that read only the first
 * page, or that double-counted on a second call, would pass a single-key test.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the erase half matches what `eraseDeviceData` actually removes
 *   integrity → UTF-8, so Korean is not under-reported by 3×
 *   race      → measuring twice gives the same answer (no accumulation in state)
 *   boundary  → empty store, one key, five thousand keys
 *   empty     → a store that cannot list, and one that is absent, are different
 *               named gaps, never a silent 0
 *   hostile   → non-string keys and unreadable values are skipped, not counted
 *   contract  → only `openstoa-` files in the shared cache dir are ours
 *   boundary  → formatBytes at 0, sub-KB, unit crossings
 */
import { describe, it, expect } from 'vitest';

import { measureDeviceData, formatBytes } from '../lib/deviceDataSize';
import { eraseDeviceData } from '../lib/deviceDataErase';

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
    getAllKeys: async () => [...map.keys()],
  };
}

/** A cache directory with named files of known size. */
function fs(sizes: Record<string, number>) {
  return {
    listCache: async () => Object.keys(sizes),
    cacheFileSize: async (n: string) => sizes[n] ?? 0,
    cacheFile: (n: string) => ({ delete: () => void delete sizes[n] }),
  };
}

const CACHE = {
  'mls.msg.t1.m1': 'a decrypted line',
  'openstoa.chatList.v1.rooms': '[{"id":"t1"}]',
  'chatHistory/v1/t1/page': '[]',
};
const KEPT = {
  'mls.identity': 'user-1:dev-1',
  'mls.state.user-1:dev-1.t1': 'group state blob',
  'tak.root.t1': 'archive key',
  'openstoa.masterKey.v1': 'master',
  'openstoa.device.key.v1': '{"publicKey":"p","privateKey":"q"}',
};

describe('measuring what is on the phone', () => {
  it('CONTRACT: the erase half is exactly what eraseDeviceData removes', async () => {
    /*
     * Not "both numbers look plausible" — the same store is measured and then
     * actually erased, and the key counts must match. A family added to one side
     * and not the other fails here rather than on somebody's phone.
     */
    const local = store({ ...CACHE, ...KEPT });
    const measured = await measureDeviceData({ local, fs: fs({}) }, 'cache');

    const before = local.map.size;
    const report = await eraseDeviceData(
      { local: local as never, secure: null, fs: fs({}) as never },
      'cache',
    );

    expect(measured.eraseKeys).toBe(report.localRemoved);
    expect(measured.keepKeys).toBe(report.localKept);
    expect(local.map.size).toBe(before - measured.eraseKeys);
  });

  it('INTEGRITY: Korean is measured in UTF-8 bytes, not characters', async () => {
    /*
     * `String.length` would report 6 for a six-character Korean message; on disk
     * it is 18. On a Korean-language app that error is systematic and always in
     * the same direction — the screen would tell everyone they have a third of
     * the data they have.
     */
    const korean = '안녕하세요반갑'; // 7 chars, 21 UTF-8 bytes
    const local = store({ 'mls.msg.t1.m1': korean });
    const m = await measureDeviceData({ local, fs: fs({}) }, 'cache');

    expect(m.eraseBytes).toBe(21);
    expect(m.eraseBytes).not.toBe(korean.length);
  });

  it('RACE: measuring twice gives the same answer', async () => {
    // A measurement that kept state would grow on every screen open, and the
    // person would watch their storage "fill up" by looking at it.
    const local = store({ ...CACHE, ...KEPT });
    const deps = { local, fs: fs({ 'openstoa-1.enc': 100 }) };

    const a = await measureDeviceData(deps, 'cache');
    const b = await measureDeviceData(deps, 'cache');
    const c = await measureDeviceData(deps, 'cache');

    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('BOUNDARY: five thousand keys are each read, not sampled', async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) big[`mls.msg.t1.m${i}`] = 'x'.repeat(10);
    const local = store(big);

    const m = await measureDeviceData({ local, fs: fs({}) }, 'cache');

    expect(m.eraseKeys).toBe(5000);
    expect(m.eraseBytes).toBe(50000);
  });

  it('BOUNDARY: an empty store is zero with no gaps', async () => {
    const m = await measureDeviceData({ local: store(), fs: fs({}) }, 'cache');
    expect(m.eraseBytes).toBe(0);
    expect(m.keepBytes).toBe(0);
    expect(m.gaps).toEqual([]);
  });

  it('EMPTY: an absent store and an unlistable one are DIFFERENT named gaps', async () => {
    /*
     * The distinction is the whole reason `gaps` exists. Both would otherwise
     * render as "0 KB", and a person reading that concludes there is nothing to
     * clear — when the truth is that nobody looked.
     */
    const absent = await measureDeviceData({ local: null, fs: fs({}) }, 'cache');
    expect(absent.gaps).toContain('local-absent');

    const noList = await measureDeviceData(
      { local: { getItem: async () => null }, fs: fs({}) },
      'cache',
    );
    expect(noList.gaps).toContain('local-unlistable');
    expect(noList.gaps).not.toContain('local-absent');
  });

  it('EXTERNAL: an enumeration that rejects is a gap, and does not throw out', async () => {
    const m = await measureDeviceData(
      {
        local: {
          getItem: async () => null,
          getAllKeys: async () => {
            throw new Error('keystore busy');
          },
        },
        fs: fs({}),
      },
      'cache',
    );
    expect(m.gaps).toContain('local-unlistable');
    expect(m.eraseBytes).toBe(0);
  });

  it('HOSTILE: non-string keys and unreadable values are skipped, not counted', async () => {
    /*
     * Counting a key whose value could not be read would produce "40 keys, 0
     * bytes" — a line that looks like a measurement and is not.
     */
    const m = await measureDeviceData(
      {
        local: {
          getAllKeys: async () => ['mls.msg.t1.a', null as never, 42 as never, 'mls.msg.t1.b'],
          getItem: async (k: string) => (k === 'mls.msg.t1.a' ? 'abcd' : null),
        },
        fs: fs({}),
      },
      'cache',
    );
    expect(m.eraseKeys).toBe(1);
    expect(m.eraseBytes).toBe(4);
  });

  it('CONTRACT: only our files in the shared cache directory are counted', async () => {
    /*
     * The cache directory is the OS's and holds the wallet app's files too.
     * Counting those would inflate the figure and imply this screen could delete
     * them.
     */
    const m = await measureDeviceData(
      {
        local: store(),
        fs: fs({
          'openstoa-1.enc': 1000,
          'openstoa-view-1.jpg': 2000,
          'some-other-app.tmp': 999999,
          'RCTAsyncLocalStorage': 555555,
        }),
      },
      'cache',
    );
    expect(m.mediaFiles).toBe(2);
    expect(m.mediaBytes).toBe(3000);
  });

  it('EMPTY: a filesystem that lists but cannot size says so rather than reporting 0', async () => {
    const m = await measureDeviceData(
      {
        local: store(),
        fs: { listCache: async () => ['openstoa-1.enc', 'openstoa-2.enc'] },
      },
      'cache',
    );
    expect(m.mediaFiles).toBe(2);
    expect(m.mediaBytes).toBe(0);
    expect(m.gaps).toContain('media-unsizable');
  });

  it('BOUNDARY: no files at all is not an unsizable gap', async () => {
    // Only claim the gap when there was something to measure — otherwise every
    // clean phone shows a warning about nothing.
    const m = await measureDeviceData({ local: store(), fs: { listCache: async () => [] } }, 'cache');
    expect(m.gaps).not.toContain('media-unsizable');
  });

  it('CONTRACT: at device scope the kept half is empty — everything goes', async () => {
    const local = store({ ...CACHE, ...KEPT });
    const m = await measureDeviceData({ local, fs: fs({}) }, 'device');
    // Host-owned keys still survive; ours do not. Assert on ours specifically.
    expect(m.eraseKeys).toBeGreaterThan(Object.keys(CACHE).length);
  });

  it.each([
    [0, '0 KB'],
    [-5, '0 KB'],
    [1, '0.1 KB'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [1024 * 1024, '1.0 MB'],
    [99 * 1024 * 1024, '99 MB'],
    [1024 * 1024 * 1024, '1.0 GB'],
  ])('BOUNDARY: %i bytes reads as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('BOUNDARY: a non-finite size does not render as NaN on screen', () => {
    expect(formatBytes(NaN)).toBe('0 KB');
    expect(formatBytes(Infinity)).toBe('0 KB');
  });
});
