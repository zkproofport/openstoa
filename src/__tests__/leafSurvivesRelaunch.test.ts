/*
 * WHY THIS EXISTS. "One phone is one device, however many times it starts."
 *
 * Measured on staging, one account and one phone:
 *
 *   mls_device_joins, user 0xfb2bb249…
 *     private   epoch  1 → 58   48 DISTINCT device ids
 *     dm        epoch  2 → 42   41 DISTINCT device ids
 *
 * Every one of those is a leaf that joined, pushed the epoch forward, and left the
 * epochs before it unreadable to the leaf that replaced it. The reader sees
 * "Waiting for the key…" on messages their own phone wrote.
 *
 * THE SUITE ALREADY LOOKED LIKE IT COVERED THIS. `leafIdentity.test.ts`,
 * `deviceJoins.test.ts`, `deviceJoinsDb.test.ts`, `mls-joiner-leaf.test.ts` and
 * `one-device.test.ts` are all in exactly this area, and all of them passed
 * throughout. They ask whether ONE leaf is formed correctly, or whether TWO
 * devices conflict. None asks what happens on the fiftieth start — and that is
 * the only question that would have caught this.
 *
 * So the axis here is REPETITION, not boundary or hostile input. A case that
 * bootstraps once cannot fail the way production failed.
 *
 * THE MECHANISM, for whoever changes this next. The identity used to live in the
 * master_key-sealed store, and `EncryptingKVStore.get` reports a value it cannot
 * open as ABSENT rather than as an error — a property `keyManager.ts` documents
 * about itself. So a single unreadable master_key turned "I have an identity"
 * into "I have never had one", which mints a fresh leaf. The fix moves the
 * identity to the raw store: it is `<userId>:<deviceId>`, which the server
 * already keeps in plain text in `mls_device_joins.leaf_identity`, so sealing it
 * protected nothing while making the one value that must outlive a key rotation
 * depend on that key.
 */
import { describe, it, expect } from 'vitest';
import { MlsSessionStore } from '../../packages/mls/src/mlsSession';
import type { SecureKVStore } from '../../packages/mls/src/mlsSession';

/** A plain store, like the raw Keychain/IndexedDB the identity now lives in. */
function plainStore(): SecureKVStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

/** A store whose reads throw, e.g. Keychain locked or unavailable. */
function brokenStore(): SecureKVStore {
  return {
    get: async () => {
      throw new Error('keychain unavailable');
    },
    set: async () => {},
  };
}

/**
 * One app launch, driving the REAL `bootstrap`.
 *
 * `bootstrap` is private, and every public method that reaches it goes on to
 * build an MLS group — which needs a transport and the crypto core, neither of
 * which this question involves. So the call is made through the instance rather
 * than reimplemented, and the group work is allowed to fail: the identity is
 * resolved FIRST, so by the time anything else throws, the store has already
 * been read or written.
 *
 * This matters more than it looks. A helper that repeated the read/mint/re-read
 * dance would pass forever while `mlsSession.ts` said something else — which is
 * exactly the shape of test that let 48 devices into production.
 */
async function launch(identityStore: SecureKVStore, seed: string): Promise<void> {
  const store = new MlsSessionStore(
    failingTransport(),
    seed,
    plainStore(),
    plainStore(),
    async () => null,
    identityStore,
  );
  // `getSession` is private; `hasJoined` is the cheapest public door to it.
  await (store as unknown as { getSession(t: string): Promise<unknown> })
    .getSession('topic-1')
    .catch(() => {
      /* group construction is out of scope — the identity step already ran */
    });
}

/** Reads what a launch left behind. */
async function identityIn(store: SecureKVStore): Promise<string | null> {
  return store.get('mls.identity');
}

/** A transport whose every call rejects — the group step is not under test. */
function failingTransport() {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('transport not available in this test');
      },
    },
  ) as never;
}

let seq = 0;
const seed = () => `mobile-seed-${(seq += 1).toString(16).padStart(12, '0')}`;

describe('one phone stays one device across launches', () => {
  it('REPETITION: 50 launches leave exactly one identity behind', async () => {
    /*
     * The count that matters. Production reached 48 — this fails at 2.
     *
     * Each launch is a fresh `MlsSessionStore` with a DIFFERENT in-memory seed,
     * which is what a real relaunch is: `deviceIdentity()` is random per process.
     * If the persisted one is not adopted, the seeds leak through and the set grows.
     */
    const store = plainStore();
    const seen = new Set<string>();

    for (let i = 0; i < 50; i++) {
      await launch(store, seed());
      const id = await identityIn(store);
      if (id) seen.add(id);
    }

    expect(seen.size).toBe(1);
  });

  it('REPETITION: the identity from launch 1 is still the one at launch 50', async () => {
    // Not the same as "one distinct value": a store rewritten with the newest
    // seed every time would also give size 1 while having rotated 50 times.
    const store = plainStore();

    await launch(store, seed());
    const first = await identityIn(store);
    for (let i = 0; i < 49; i++) await launch(store, seed());

    expect(await identityIn(store)).toBe(first);
  });

  it('CONTRACT: a genuinely new install mints once and persists it', async () => {
    const store = plainStore();
    expect(store.data.has('mls.identity')).toBe(false);

    await launch(store, 'mobile-seed-000000000001');

    expect(await identityIn(store)).toBeTruthy();
  });

  it('INTEGRITY: a store that forgets is what produced 48 devices', async () => {
    /*
     * The counter-example, kept because it names the defect. This is the sealed
     * store after a master_key change: every read says "nothing here", so nothing
     * is ever adopted. If a future change puts the identity back behind a key
     * that can rotate, THIS is the behaviour it gets.
     */
    const writes: string[] = [];
    const forgetful: SecureKVStore = {
      get: async () => null,
      set: async (_k, v) => {
        writes.push(v);
      },
    };

    for (let i = 0; i < 10; i++) await launch(forgetful, seed());

    expect(new Set(writes).size).toBe(10);
  });

  it('INTEGRITY: a failing read must not be treated as "no identity yet"', async () => {
    /*
     * The other half, and the reason the throw is re-raised rather than caught.
     * The old code swallowed it and carried on with the random in-memory value,
     * minting a leaf on a transient failure. Refusing is the honest outcome:
     * chat unavailable beats chat that works while discarding the past.
     *
     * Asserted through the real bootstrap, so the message has to survive.
     */
    const store = new MlsSessionStore(
      failingTransport(),
      'mobile-seed-000000000002',
      plainStore(),
      plainStore(),
      async () => null,
      brokenStore(),
    );

    await expect(
      (store as unknown as { getSession(t: string): Promise<unknown> }).getSession('topic-1'),
    ).rejects.toThrow(/refusing to mint a new leaf/);
  });

  it('CONTRACT: the identity is stored under `mls.identity`, and nothing else is', async () => {
    // Written by one place and read by another; a rename on one side alone is a
    // silent re-mint for every existing install.
    const store = plainStore();
    await launch(store, seed());
    expect([...store.data.keys()]).toEqual(['mls.identity']);
  });
});

describe('MlsSessionStore accepts a separate identity store', () => {
  it('CONTRACT: the constructor takes one, so the identity need not be sealed', () => {
    /*
     * Guards the wiring rather than the behaviour: the parameter existing is
     * what lets mobile, web and the SDK pass a raw store. Dropping it would put
     * every caller back on the sealed store with no other test failing.
     */
    const raw = plainStore();
    const store = new MlsSessionStore(
      { } as never,
      'mobile-deadbeefdeadbeef',
      plainStore(),
      plainStore(),
      async () => null,
      raw,
    );
    expect(store).toBeInstanceOf(MlsSessionStore);
  });
});
