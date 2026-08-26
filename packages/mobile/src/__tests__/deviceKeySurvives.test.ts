/*
 * The device keypair is made ONCE and never quietly remade.
 *
 * WHY, in numbers. Staging held one account on one phone with 48 distinct device
 * ids across epochs 1→58 in a single room, and 41 across 2→42 in another. Each
 * was a leaf that joined, moved the epoch on, and left everything before it
 * unreadable to its successor — so the reader is told to ask another member for
 * keys their own phone wrote yesterday. The mechanism was a store read that
 * answered "nothing here" when it meant "could not open", and code that took the
 * first answer at face value.
 *
 * This keypair replaces the self-reported id that made that possible, so it must
 * not repeat the failure it exists to end.
 *
 * THE AXIS IS REPETITION. Every test that already covered leaf identity, device
 * joins and takeover passed throughout — they ask what ONE call does. Fifty
 * launches is the question none of them asked, and the only one that fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('react-native-quick-crypto', () => {
  let n = 0;
  return {
    Ed: class {
      private pub: Uint8Array;
      private priv: Uint8Array;
      constructor() {
        n += 1;
        this.pub = new Uint8Array(32).fill(n);
        this.priv = new Uint8Array(64).fill(n);
      }
      async generateKeyPair() {}
      getPublicKey() {
        return this.pub.buffer.slice(0) as ArrayBuffer;
      }
      getPrivateKey() {
        return this.priv.buffer.slice(0) as ArrayBuffer;
      }
      async sign(msg: Uint8Array, key: Uint8Array) {
        // Deterministic and key-bound: a different key gives a different value,
        // which is what the verify case needs in order to mean anything.
        const out = new Uint8Array(64);
        out.set(key.slice(0, 8));
        out.set(msg.slice(0, 8), 8);
        return out.buffer as ArrayBuffer;
      }
      async verify(sig: Uint8Array, msg: Uint8Array, key: Uint8Array) {
        /*
         * Compare the FULL eight bytes each side, not the first.
         *
         * The first draft compared `sig[0]` and `sig[8]` alone and the
         * different-nonce case passed when it should have failed: `nonce-one`
         * and `nonce-two` both begin with `n`. The mock, not the code, was
         * wrong — worth recording, because the shape of the mistake is the one
         * this whole file exists to catch. A weak comparison reports a match
         * that is not there.
         */
        const eq = (a: Uint8Array, b: Uint8Array, at: number) =>
          [...b.slice(0, 8)].every((x, i) => a[at + i] === x);
        // The mock's public and private keys are both `fill(n)`, so a signature
        // made with private n verifies against public n.
        return eq(sig, key, 0) && eq(sig, msg, 8);
      }
    },
  };
});

import {
  deviceKeyPair,
  signChallenge,
  verifyChallenge,
  resetDeviceKeyMemo,
  DEVICE_KEY_STORE_KEY,
  type SecureStoreLike,
} from '../crypto/deviceKey';

/** A store that keeps what it is given. */
function plainStore(): SecureStoreLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

/**
 * A store that accepts writes and answers every read with null — the shape of
 * `EncryptingKVStore` after its key changes. This is what turned one phone into
 * 48, so it is kept as a case rather than described in a comment.
 */
function forgetfulStore(): SecureStoreLike & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    getItem: async () => null,
    setItem: async (_k, v) => {
      writes.push(v);
    },
  };
}

/** A store whose reads throw — Keychain locked, or simply unavailable. */
function brokenStore(): SecureStoreLike {
  return {
    getItem: async () => {
      throw new Error('keychain unavailable');
    },
    setItem: async () => {},
  };
}

/** One app launch: the memo is per process, so a relaunch clears it. */
async function launch(store: SecureStoreLike) {
  resetDeviceKeyMemo();
  return deviceKeyPair(store);
}

beforeEach(() => {
  resetDeviceKeyMemo();
});

describe('one install keeps one device key', () => {
  it('REPETITION: 50 launches produce exactly one keypair', async () => {
    const store = plainStore();
    const pubs = new Set<string>();

    for (let i = 0; i < 50; i++) pubs.add((await launch(store)).publicKey);

    expect(pubs.size).toBe(1);
  });

  it('REPETITION: the key from launch 1 is still the key at launch 50', async () => {
    // Distinct from "one value": a store rewritten with the newest key each time
    // would also give size 1 while having rotated fifty times.
    const store = plainStore();

    const first = await launch(store);
    for (let i = 0; i < 49; i++) await launch(store);

    expect((await launch(store)).publicKey).toBe(first.publicKey);
  });

  it('CONTRACT: a genuinely new install generates once and persists it', async () => {
    const store = plainStore();
    expect(store.data.has(DEVICE_KEY_STORE_KEY)).toBe(false);

    const pair = await launch(store);

    expect(pair.publicKey).toBeTruthy();
    expect(pair.privateKey).toBeTruthy();
    expect(JSON.parse(store.data.get(DEVICE_KEY_STORE_KEY)!)).toEqual(pair);
  });

  it('INTEGRITY: a store that forgets is what produced 48 devices', async () => {
    const store = forgetfulStore();

    for (let i = 0; i < 10; i++) await launch(store);

    expect(new Set(store.writes).size).toBe(10);
  });

  it('INTEGRITY: a failing read must not be read as "no key yet"', async () => {
    /*
     * The half that matters most. A throw is not an answer, and treating it as
     * one is exactly how a transient failure became a permanent loss of history.
     */
    await expect(launch(brokenStore())).rejects.toThrow(/refusing to generate a new identity/);
  });

  it('INTEGRITY: a stored-but-unreadable key is NOT overwritten', async () => {
    /*
     * Whatever is there was written by this app. Replacing it silently is the
     * move that loses history, so it fails loudly and a human decides.
     */
    const store = plainStore();
    store.data.set(DEVICE_KEY_STORE_KEY, 'not json at all');

    await expect(launch(store)).rejects.toThrow(/present but unreadable/);
    expect(store.data.get(DEVICE_KEY_STORE_KEY)).toBe('not json at all');
  });

  it('BOUNDARY: a half-written record is rejected rather than half-used', async () => {
    const store = plainStore();
    store.data.set(DEVICE_KEY_STORE_KEY, JSON.stringify({ publicKey: 'abc' }));

    await expect(launch(store)).rejects.toThrow(/present but unreadable/);
  });

  it('RACE: two callers in one process resolve to the same key', async () => {
    // The memo exists for this. Both generating and both writing would leave the
    // account holding a public key the device can no longer sign with.
    const store = plainStore();

    const [a, b] = await Promise.all([deviceKeyPair(store), deviceKeyPair(store)]);

    expect(a.publicKey).toBe(b.publicKey);
    expect(store.data.size).toBe(1);
  });
});

describe('the challenge proves possession, not a claimed name', () => {
  it('CONTRACT: a signature from this device verifies against its public key', async () => {
    const store = plainStore();
    const { publicKey } = await launch(store);
    const nonce = Buffer.from('a-server-nonce').toString('base64');

    const sig = await signChallenge(store, nonce);

    expect(await verifyChallenge(publicKey, nonce, sig)).toBe(true);
  });

  it('INTEGRITY: another device cannot sign for this one', async () => {
    /*
     * The whole point. Knowing the id was enough before; knowing the public key
     * has to not be enough now.
     */
    const mine = plainStore();
    const theirs = plainStore();
    const { publicKey: myPub } = await launch(mine);
    await launch(theirs);
    const nonce = Buffer.from('a-server-nonce').toString('base64');

    const theirSig = await signChallenge(theirs, nonce);

    expect(await verifyChallenge(myPub, nonce, theirSig)).toBe(false);
  });

  it('INTEGRITY: a signature over one nonce does not answer another', async () => {
    // Otherwise a captured signature is a permanent password.
    const store = plainStore();
    const { publicKey } = await launch(store);
    const nonce = Buffer.from('nonce-one').toString('base64');
    const other = Buffer.from('nonce-two').toString('base64');

    const sig = await signChallenge(store, nonce);

    expect(await verifyChallenge(publicKey, other, sig)).toBe(false);
  });
});
