/**
 * Running an erase against stores that behave like the real ones.
 *
 * THE CUMULATIVE AXIS IS THE POINT. "Clear the cache once and the keys are
 * still there" is a weaker claim than it looks: it holds for an implementation
 * that deletes nothing, for one that deletes the right things, and for one that
 * deletes one extra key per run. The interesting question is what the device
 * looks like after somebody has tapped the button twenty times over a month, so
 * that is what most of these do — clear, write more cache, clear again, and
 * assert the protected set is byte-identical and the rooms still open.
 *
 * THE OTHER HALF IS THE CAPABILITY GAP. The mini-app borrows its storage from
 * the host binary, and a host that predates `removeItem` / `getAllKeys` cannot
 * delete anything. For "erase everything", a silent no-op is the worst outcome
 * available: the person believes their keys are gone and they are not. So the
 * absence of each capability is a named, asserted outcome rather than a branch
 * nobody exercises.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a cache clear removes exactly the cache families and nothing
 *                else; a device erase removes the named secure keys too
 *   integrity  → N repeated clears leave the protected set unchanged (the
 *                cumulative axis), and a clear is idempotent after the first
 *   integrity  → a cache clear NEVER calls the secure store, even when secure
 *                keys are passed to it by mistake
 *   boundary   → an empty store, a store with 5,000 keys
 *   empty      → absent local store, absent secure store, absent filesystem —
 *                each its own gap, none of them silent
 *   hostile    → an enumeration that returns junk, nulls, or a non-array
 *   external   → a store whose `removeItem` rejects for some keys, and one that
 *                rejects for all of them
 *   race       → media files that disappear between the listing and the delete
 *   authz      → host-owned keys survive both scopes
 */
import { describe, it, expect, vi } from 'vitest';
import {
  eraseDeviceData,
  eraseWasBlocked,
  eraseWasComplete,
  type ErasableStore,
} from '../lib/deviceDataErase';
import { secureEraseKeys } from '../lib/deviceData';

const IDENTITY = 'user-1:dev-1';

const PROTECTED = [
  'mls.identity',
  'mls.state.user-1:dev-1.t1',
  'mls.state.user-1:dev-1.t2',
  'tak.root.t1',
  'tak.root.orphan.t1',
  'tak.epoch.t1.0',
  'tak.epoch.t1.1',
  'tak.manifest',
  'openstoa.masterKey.v1',
  'openstoa.masterKey.retired.v1',
  'openstoa.device.key.v1',
  'openstoa.device.id',
];

const HOST_OWNED = ['openstoa.token.v1', 'openstoa.loggedOut.v1', 'openstoa.language', 'privy:session'];

function cacheKeys(round: number): string[] {
  return [
    `mls.msg.t1.m${round}`,
    `mls.msg.t2.m${round}`,
    'openstoa.chatList.v1.user-1',
    'chatHistory/v1/user-1/t1',
    'chatHistory/v1/index/user-1',
  ];
}

/**
 * A key/value store with the capabilities a modern host has.
 *
 * Backed by a Map so a delete is a real delete and a second enumeration sees
 * the result of the first — which is what makes the repeated-clear assertions
 * mean anything.
 */
function store(initial: readonly string[] = []): ErasableStore & { map: Map<string, string>; removals: string[] } {
  const map = new Map<string, string>(initial.map((k) => [k, 'v']));
  const removals: string[] = [];
  return {
    map,
    removals,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => {
      removals.push(k);
      map.delete(k);
    },
    getAllKeys: async () => [...map.keys()],
  };
}

/** A filesystem whose cache directory can be listed, with deletable files. */
function fakeFs(names: string[]) {
  const present = new Set(names);
  return {
    present,
    listCache: async () => [...present],
    cacheFile: (name: string) => ({
      delete: () => {
        if (!present.delete(name)) throw new Error('ENOENT');
      },
    }),
  };
}

describe('clearing the cache', () => {
  it('CONTRACT: removes the cache families and nothing else', async () => {
    const local = store([...PROTECTED, ...HOST_OWNED, ...cacheKeys(0)]);
    const secure = store(PROTECTED);

    const r = await eraseDeviceData({ local, secure, fs: fakeFs([]) }, 'cache');

    expect(r.localRemoved).toBe(cacheKeys(0).length);
    expect([...local.map.keys()].sort()).toEqual([...PROTECTED, ...HOST_OWNED].sort());
    expect(secure.removals).toEqual([]);
    expect(r.secureRemoved).toBe(0);
    expect(eraseWasComplete(r)).toBe(true);
  });

  it('INTEGRITY: the secure store is not touched even when secure keys are passed by mistake', async () => {
    /*
     * The scope check lives at the door of `eraseSecure` as well as inside
     * `keyVerdict`. A caller that handed a cache clear a full key list would
     * otherwise empty the Keychain while the person read "your keys are not
     * touched".
     */
    const secure = store(PROTECTED);
    const r = await eraseDeviceData(
      {
        local: store(cacheKeys(0)),
        secure,
        fs: fakeFs([]),
        secureKeys: secureEraseKeys({ identity: IDENTITY, topicIds: ['t1'], takKeys: [] }),
      },
      'cache',
    );

    expect(secure.removals).toEqual([]);
    expect([...secure.map.keys()].sort()).toEqual([...PROTECTED].sort());
    expect(r.secureRemoved).toBe(0);
  });

  it('CUMULATIVE: twenty clears leave the protected set byte-identical', async () => {
    const local = store([...PROTECTED, ...HOST_OWNED]);
    const secure = store(PROTECTED);
    const fs = fakeFs([]);

    for (let round = 0; round < 20; round++) {
      // Between clears the app keeps caching, exactly as it would on a phone.
      for (const k of cacheKeys(round)) await local.setItem(k, 'v');
      for (const f of [`openstoa-${round}.enc`, `openstoa-view-${round}.jpg`]) fs.present.add(f);

      const r = await eraseDeviceData({ local, secure, fs }, 'cache');

      expect(r.localRemoved).toBe(cacheKeys(round).length);
      expect(r.mediaRemoved).toBe(2);
      expect(eraseWasComplete(r)).toBe(true);
      // The rooms are still openable: identity, group state and archive keys.
      expect([...local.map.keys()].sort()).toEqual([...PROTECTED, ...HOST_OWNED].sort());
      expect([...secure.map.keys()].sort()).toEqual([...PROTECTED].sort());
    }
    expect(secure.removals).toEqual([]);
  });

  it('CUMULATIVE: a clear with nothing new to clear removes nothing and still reports success', async () => {
    const local = store([...PROTECTED, ...cacheKeys(0)]);
    const first = await eraseDeviceData({ local, secure: store([]), fs: fakeFs([]) }, 'cache');
    expect(first.localRemoved).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) {
      const again = await eraseDeviceData({ local, secure: store([]), fs: fakeFs([]) }, 'cache');
      expect(again.localRemoved).toBe(0);
      expect(again.localKept).toBe(PROTECTED.length);
      expect(eraseWasComplete(again)).toBe(true);
    }
  });
});

describe('erasing the device', () => {
  it('CONTRACT: removes the cache, the named secure keys, and the media', async () => {
    const local = store([...PROTECTED, ...HOST_OWNED, ...cacheKeys(0)]);
    const secure = store(PROTECTED);
    const fs = fakeFs(['openstoa-abc.enc', 'openstoa-view-abc.jpg', 'unrelated.bin']);
    const secureKeys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: ['t1', 't2'],
      takKeys: ['tak.root.t1', 'tak.epoch.t1.0', 'tak.epoch.t1.1', 'tak.manifest'],
    });

    const r = await eraseDeviceData({ local, secure, fs, secureKeys }, 'device');

    // Every protected key named is gone from the Keychain.
    for (const k of PROTECTED) expect(secure.map.has(k)).toBe(false);
    // The local store keeps only what belongs to the host.
    expect([...local.map.keys()].sort()).toEqual([...HOST_OWNED].sort());
    // Media went; the host's own file did not.
    expect([...fs.present]).toEqual(['unrelated.bin']);
    expect(r.mediaRemoved).toBe(2);
    expect(eraseWasComplete(r)).toBe(true);
  });

  it('INTEGRITY: a key the caller never named survives — which is why the name list matters', async () => {
    /*
     * NOT a wish, a demonstration. The Keychain cannot be enumerated, so an
     * erase removes exactly what it was told to remove. A topic missing from
     * both the server list and the offline cache leaves its group state and its
     * orphan root on the device forever, and this test exists so that fact is
     * visible in the suite rather than discovered on a phone.
     */
    const secure = store([...PROTECTED, 'mls.state.user-1:dev-1.t-unknown', 'tak.root.orphan.t-unknown']);
    const secureKeys = secureEraseKeys({ identity: IDENTITY, topicIds: ['t1', 't2'], takKeys: [] });

    await eraseDeviceData({ local: store([]), secure, fs: fakeFs([]), secureKeys }, 'device');

    expect(secure.map.has('mls.state.user-1:dev-1.t-unknown')).toBe(true);
    expect(secure.map.has('tak.root.orphan.t-unknown')).toBe(true);
  });

  it('CUMULATIVE: erasing twice is safe and the second run finds nothing', async () => {
    const local = store([...PROTECTED, ...cacheKeys(0)]);
    const secure = store(PROTECTED);
    const secureKeys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: ['t1', 't2'],
      takKeys: PROTECTED.filter((k) => k.startsWith('tak.')),
    });

    const first = await eraseDeviceData({ local, secure, fs: fakeFs([]), secureKeys }, 'device');
    const second = await eraseDeviceData({ local, secure, fs: fakeFs([]), secureKeys }, 'device');

    expect(first.localRemoved).toBeGreaterThan(0);
    expect(second.localRemoved).toBe(0);
    // The secure count does NOT drop to zero: `removeItem` on an absent key is
    // not an error in either OS, so the second run reports the same attempts.
    // What matters is that it does not throw and nothing comes back.
    expect(second.secureRemoved).toBe(first.secureRemoved);
    expect(second.failed).toBe(0);
  });
});

describe('a host binary that cannot delete', () => {
  it('EMPTY: no local store is a named gap, not a success', async () => {
    const r = await eraseDeviceData({ local: null, secure: store([]), fs: fakeFs([]) }, 'cache');
    expect(r.gaps).toContain('local-store-absent');
    expect(eraseWasComplete(r)).toBe(false);
    // Not BLOCKING: there is genuinely nothing persisted to remove.
    expect(eraseWasBlocked(r)).toBe(false);
  });

  it('EXTERNAL: a store without `getAllKeys` blocks — it cannot find the caches', async () => {
    const bare: ErasableStore = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
    const r = await eraseDeviceData({ local: bare, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(r.gaps).toContain('local-no-enumeration');
    expect(eraseWasBlocked(r)).toBe(true);
    expect(r.localRemoved).toBe(0);
  });

  it('EXTERNAL: a store without `removeItem` blocks rather than reporting a clean run', async () => {
    const readOnly: ErasableStore = {
      getItem: async () => null,
      setItem: async () => {},
      getAllKeys: async () => [...cacheKeys(0)],
    };
    const r = await eraseDeviceData({ local: readOnly, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(r.gaps).toContain('local-no-removal');
    expect(eraseWasBlocked(r)).toBe(true);
  });

  it('EXTERNAL: a secure store without `removeItem` blocks a device erase — the keys STAY', async () => {
    /*
     * THE failure this whole reporting layer exists for. Without the gap, the
     * sheet would close on "Done" while every chat key remained on the phone.
     */
    const readOnly: ErasableStore = { getItem: async () => null, setItem: async () => {} };
    const r = await eraseDeviceData(
      { local: store([]), secure: readOnly, fs: fakeFs([]), secureKeys: ['mls.identity'] },
      'device',
    );

    expect(r.gaps).toContain('secure-no-removal');
    expect(eraseWasBlocked(r)).toBe(true);
    expect(r.secureRemoved).toBe(0);
  });

  it('EMPTY: no filesystem, and a filesystem that cannot list, are different gaps', async () => {
    const noFs = await eraseDeviceData({ local: store([]), secure: store([]), fs: null }, 'cache');
    expect(noFs.gaps).toContain('media-fs-absent');

    const noList = await eraseDeviceData(
      { local: store([]), secure: store([]), fs: { cacheFile: () => ({ delete: () => {} }) } },
      'cache',
    );
    expect(noList.gaps).toContain('media-no-listing');
  });
});

describe('stores that misbehave', () => {
  it('HOSTILE: an enumeration returning junk is treated as unlistable, not as empty', async () => {
    const junk: ErasableStore = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
      getAllKeys: async () => 'not an array' as unknown as string[],
    };
    const r = await eraseDeviceData({ local: junk, secure: store([]), fs: fakeFs([]) }, 'cache');
    expect(r.gaps).toContain('local-no-enumeration');
  });

  it('HOSTILE: nulls and non-strings inside the key list are skipped, not deleted', async () => {
    const removals: unknown[] = [];
    const mixed: ErasableStore = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async (k) => void removals.push(k),
      getAllKeys: async () =>
        [null, undefined, 42, {}, 'mls.msg.t1.m1', 'mls.identity'] as unknown as string[],
    };
    const r = await eraseDeviceData({ local: mixed, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(removals).toEqual(['mls.msg.t1.m1']);
    expect(r.localRemoved).toBe(1);
  });

  it('EXTERNAL: an enumeration that rejects is a gap, and does not throw out of the call', async () => {
    const angry: ErasableStore = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
      getAllKeys: async () => {
        throw new Error('storage unavailable');
      },
    };
    const r = await eraseDeviceData({ local: angry, secure: store([]), fs: fakeFs([]) }, 'cache');
    expect(r.gaps).toContain('local-no-enumeration');
  });

  it('EXTERNAL: one key that will not delete does not abort the rest', async () => {
    const keys = [...cacheKeys(0)];
    const map = new Map(keys.map((k) => [k, 'v']));
    const flaky: ErasableStore = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async (k) => {
        if (k === keys[1]) throw new Error('locked');
        map.delete(k);
      },
      getAllKeys: async () => [...map.keys()],
    };

    const r = await eraseDeviceData({ local: flaky, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(r.localRemoved).toBe(keys.length - 1);
    expect(r.failed).toBe(1);
    expect(r.gaps).toContain('some-deletes-failed');
    expect(eraseWasComplete(r)).toBe(false);
    // Not "blocked": the host CAN delete, it just did not for one key.
    expect(eraseWasBlocked(r)).toBe(false);
  });

  it('RACE: a media file that vanishes between the listing and the delete is counted, not hidden', async () => {
    /*
     * The OS reclaims this directory whenever it likes and `chatMediaFiles`
     * writes into it from another task, so this is the normal case rather than
     * an exotic one. It is still reported: a permissions problem and a tidy
     * cache must not look identical.
     */
    const fs = {
      listCache: async () => ['openstoa-gone.enc', 'openstoa-here.enc'],
      cacheFile: (name: string) => ({
        delete: () => {
          if (name === 'openstoa-gone.enc') throw new Error('ENOENT');
        },
      }),
    };
    const r = await eraseDeviceData({ local: store([]), secure: store([]), fs }, 'cache');

    expect(r.mediaRemoved).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.gaps).toContain('some-deletes-failed');
  });

  it('EXTERNAL: `eraseDeviceData` never rejects, whatever the stores do', async () => {
    const hostile: ErasableStore = {
      getItem: async () => {
        throw new Error('no');
      },
      setItem: async () => {
        throw new Error('no');
      },
      removeItem: async () => {
        throw new Error('no');
      },
      getAllKeys: async () => [...cacheKeys(0)],
    };
    await expect(
      eraseDeviceData(
        {
          local: hostile,
          secure: hostile,
          fs: {
            listCache: async () => {
              throw new Error('no');
            },
            cacheFile: () => ({
              delete: () => {
                throw new Error('no');
              },
            }),
          },
          secureKeys: ['mls.identity'],
        },
        'device',
      ),
    ).resolves.toBeTruthy();
  });
});

describe('scale', () => {
  it('BOUNDARY: an empty store completes with nothing removed and nothing kept', async () => {
    const r = await eraseDeviceData({ local: store([]), secure: store([]), fs: fakeFs([]) }, 'cache');
    expect(r.localRemoved).toBe(0);
    expect(r.localKept).toBe(0);
    expect(eraseWasComplete(r)).toBe(true);
  });

  it('BOUNDARY: five thousand keys are classified individually', async () => {
    const cache = Array.from({ length: 5000 }, (_, i) => `mls.msg.t${i % 7}.m${i}`);
    const local = store([...cache, ...PROTECTED, ...HOST_OWNED]);

    const r = await eraseDeviceData({ local, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(r.localRemoved).toBe(5000);
    expect(r.localKept).toBe(PROTECTED.length + HOST_OWNED.length);
    expect([...local.map.keys()].sort()).toEqual([...PROTECTED, ...HOST_OWNED].sort());
  });

  it('CONTRACT: removal is attempted once per key, never twice', async () => {
    const local = store([...cacheKeys(0), ...PROTECTED]);
    const spy = vi.spyOn(local, 'removeItem');

    await eraseDeviceData({ local, secure: store([]), fs: fakeFs([]) }, 'cache');

    expect(spy).toHaveBeenCalledTimes(cacheKeys(0).length);
    expect(new Set(local.removals).size).toBe(local.removals.length);
  });
});
