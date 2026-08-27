/*
 * `proveDevice` sends the body the route accepts, signed over the nonce it was
 * given — and sends nothing at all when there is nothing to answer.
 *
 * WHY THE BODY SHAPE IS WORTH ASSERTING. `POST /api/auth/device/challenge`
 * answers a missing or misnamed field with 400, and the caller swallows every
 * failure on purpose (see `useDeviceProof`'s header: a red line here would
 * report a degraded GROUPING as if the account were broken). So a renamed field
 * produces exactly one visible symptom — the takeover prompt coming back on
 * every sign-in, weeks later, on somebody else's phone.
 *
 * WHY THE SIGNATURE IS VERIFIED FOR REAL. A mock `sign` that ignores its message
 * passes any test that only checks "a signature was sent", and the real failure
 * this whole mechanism guards against is a signature that verifies NOWHERE:
 * `signChallenge` signs the DECODED nonce bytes, and a caller that base64-decoded
 * on one side and not the other would look identical from the outside. So
 * `react-native-quick-crypto` is stood in for by node's own Ed25519 — real
 * curve, real bytes — rather than by a stub that returns a constant, and the
 * signature is checked with the real `verifyChallenge`.
 *
 * WHY `.tsx` WITH NO JSX IN IT. The root `vitest.config.ts` excludes
 * `packages/mobile/**\/*.test.tsx` and nothing else from this package, because
 * the mini-app's aliases (`react-native`, `@openstoa/miniapp-bridge`) exist only
 * in `packages/mobile/vitest.config.ts`. `useDeviceProof` imports `useHost` as a
 * VALUE, so a `.test.ts` here would fail to resolve under the root config and
 * take unrelated files down with it — the same trap the root config's own
 * `@openstoa/api-types` note records. The extension is what keeps this file in
 * the one config that can load it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → exactly {nonce, signature, publicKey} to exactly one path
 *   integrity  → the signature verifies against the key that was sent, and
 *                does NOT verify against a different nonce
 *   integrity  → the public key sent matches the shape the SERVER accepts
 *   empty      → no nonce / empty-string nonce / null body → skipped, no POST
 *   hostile    → a non-string nonce (number, object, array) → skipped, no POST
 *   external   → a rejected GET or POST propagates; the caller owns swallowing
 *   repetition → two proofs in one process send the SAME key
 *   boundary / UTF-8 / large / authz / race → N/A: the nonce is server-issued
 *                base64 and this function takes no user input and no identity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * Node's Ed25519, wearing `react-native-quick-crypto`'s interface. The native
 * module cannot load off a device; the CURVE can, and it is the part that has to
 * be real here.
 */
vi.mock('react-native-quick-crypto', async () => {
  const { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } =
    await import('node:crypto');

  // The fixed DER preambles for a raw 32-byte Ed25519 key, so the raw halves the
  // app stores can be turned back into key objects node will accept.
  const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
  const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  const buf = (b: Buffer): ArrayBuffer =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

  return {
    Ed: class {
      private pub: Buffer = Buffer.alloc(0);
      private priv: Buffer = Buffer.alloc(0);
      async generateKeyPair() {
        const pair = generateKeyPairSync('ed25519');
        this.pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
        this.priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
      }
      getPublicKey() {
        return buf(this.pub);
      }
      getPrivateKey() {
        return buf(this.priv);
      }
      async sign(msg: Uint8Array, key: Uint8Array) {
        const k = createPrivateKey({
          key: Buffer.concat([PKCS8, Buffer.from(key)]),
          format: 'der',
          type: 'pkcs8',
        });
        return buf(sign(null, Buffer.from(msg), k));
      }
      async verify(sig: Uint8Array, msg: Uint8Array, key: Uint8Array) {
        const k = createPublicKey({
          key: Buffer.concat([SPKI, Buffer.from(key)]),
          format: 'der',
          type: 'spki',
        });
        return verify(null, Buffer.from(msg), k, Buffer.from(sig));
      }
    },
  };
});

import { proveDevice } from '../hooks/useDeviceProof';
import { verifyChallenge, resetDeviceKeyMemo, type SecureStoreLike } from '../crypto/deviceKey';

/** The one path both halves of the exchange use. */
const PATH = '/api/auth/device/challenge';

/*
 * The server's own shape check, copied from `src/lib/deviceFromRequest.ts`.
 *
 * Duplicated deliberately rather than imported: it lives in the web app, which
 * this package cannot reach, and the point of the case is that the two ends
 * AGREE. A key encoded base64url would satisfy every assertion in this file
 * except this one, and would then be dropped by the server on every request
 * with nothing logged.
 */
const SERVER_ACCEPTS = /^[A-Za-z0-9+/]{43}=$/;

function plainStore(): SecureStoreLike {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

/** A client whose GET answers with whatever this test wants to hand back. */
function client(issued: unknown) {
  return {
    // Typed parameters so `mock.calls[0]` is a PAIR rather than `[]` — the
    // destructuring below is the assertion, and an untyped `vi.fn()` makes it
    // unreachable to the typechecker.
    get: vi.fn(async (_path: string) => issued),
    post: vi.fn(async (_path: string, _body: unknown) => ({ ok: true })),
  };
}

/** A server nonce is base64 of random bytes; this is one. */
const NONCE = Buffer.from('a-server-issued-nonce').toString('base64');

beforeEach(() => {
  // The keypair is memoised per PROCESS, so each case must start from a device
  // that has not resolved one yet — otherwise every store shares one key.
  resetDeviceKeyMemo();
});

describe('proveDevice sends what the route requires', () => {
  it('CONTRACT: exactly {nonce, signature, publicKey}, to the challenge path', async () => {
    const c = client({ nonce: NONCE, expiresInSeconds: 120 });

    const outcome = await proveDevice(c, plainStore());

    expect(outcome).toBe('proved');
    expect(c.get).toHaveBeenCalledWith(PATH);
    expect(c.post).toHaveBeenCalledTimes(1);
    const [path, body] = c.post.mock.calls[0];
    expect(path).toBe(PATH);
    const fields = body as Record<string, unknown>;
    // Sorted keys, not `toMatchObject` — a renamed or extra field must fail.
    expect(Object.keys(fields).sort()).toEqual(['nonce', 'publicKey', 'signature']);
    expect(fields.nonce).toBe(NONCE);
    expect(typeof fields.signature).toBe('string');
    expect(typeof fields.publicKey).toBe('string');
  });

  it('INTEGRITY: the signature verifies against the key that was sent', async () => {
    /*
     * The assertion the whole exchange rests on. The server verifies exactly
     * this pairing; anything that passes here and fails there is a bug in one
     * of the two encodings, which is why the curve is real.
     */
    const c = client({ nonce: NONCE });

    await proveDevice(c, plainStore());

    const body = c.post.mock.calls[0][1] as { publicKey: string; signature: string };
    expect(await verifyChallenge(body.publicKey, NONCE, body.signature)).toBe(true);
  });

  it('INTEGRITY: the signature does NOT answer a different nonce', async () => {
    /*
     * The half that catches a signer which ignores its message. Without it, a
     * captured signature would be a permanent password and this file would
     * still be green.
     */
    const c = client({ nonce: NONCE });

    await proveDevice(c, plainStore());

    const body = c.post.mock.calls[0][1] as { publicKey: string; signature: string };
    const other = Buffer.from('a-different-server-nonce').toString('base64');
    expect(await verifyChallenge(body.publicKey, other, body.signature)).toBe(false);
  });

  it('INTEGRITY: the public key sent is in the shape the SERVER accepts', async () => {
    // The other end of this pairing is `deviceKeyHeaderIsShapeChecked.test.ts`.
    const c = client({ nonce: NONCE });

    await proveDevice(c, plainStore());

    const { publicKey } = c.post.mock.calls[0][1] as { publicKey: string };
    expect(publicKey).toMatch(SERVER_ACCEPTS);
    expect(publicKey).toHaveLength(44);
  });

  it('REPETITION: two proofs from one install send the same key', async () => {
    /*
     * A device that presents a DIFFERENT key for an id it already registered is
     * answered 409 by the route — which is correct, and is also what one phone
     * turning into 48 looked like. Sending one key per call would produce that
     * on the second sign-in of every session.
     */
    const store = plainStore();
    const first = client({ nonce: NONCE });
    const second = client({ nonce: Buffer.from('another-nonce').toString('base64') });

    await proveDevice(first, store);
    await proveDevice(second, store);

    const a = (first.post.mock.calls[0][1] as { publicKey: string }).publicKey;
    const b = (second.post.mock.calls[0][1] as { publicKey: string }).publicKey;
    expect(a).toBe(b);
  });
});

describe('proveDevice answers nothing when there is nothing to answer', () => {
  /*
   * Each of these would otherwise SPEND the attempt: the nonce is one-time, so
   * posting a signature over an empty or invented challenge registers nothing
   * and consumes the only value that could have.
   */
  it('EMPTY: a response with no nonce is skipped and posts nothing', async () => {
    const c = client({});

    expect(await proveDevice(c, plainStore())).toBe('skipped');
    expect(c.post).not.toHaveBeenCalled();
  });

  it('EMPTY: an empty-string nonce is skipped', async () => {
    const c = client({ nonce: '' });

    expect(await proveDevice(c, plainStore())).toBe('skipped');
    expect(c.post).not.toHaveBeenCalled();
  });

  it('EMPTY: a null or undefined response body is skipped, not a crash', async () => {
    // A client that returns nothing on a 204 must not throw on `.nonce`.
    for (const issued of [null, undefined]) {
      const c = client(issued);
      expect(await proveDevice(c, plainStore())).toBe('skipped');
      expect(c.post).not.toHaveBeenCalled();
      resetDeviceKeyMemo();
    }
  });

  it('HOSTILE: a non-string nonce is skipped rather than coerced', async () => {
    /*
     * `String(123)` would be a perfectly signable value and a perfectly useless
     * one — the server would reject it, silently, forever. Every non-string
     * shape is refused before any signing happens.
     */
    for (const nonce of [123, 0, true, false, {}, [], { nonce: 'nested' }, null]) {
      const c = client({ nonce });
      expect(await proveDevice(c, plainStore())).toBe('skipped');
      expect(c.post).not.toHaveBeenCalled();
      resetDeviceKeyMemo();
    }
  });
});

describe('proveDevice propagates failures rather than hiding them', () => {
  /*
   * Swallowing belongs to the CALLER (`useDeviceProof` catches and ignores, and
   * its header says why). A function that swallowed here as well would leave no
   * layer able to observe the failure at all — including a test.
   */
  it('EXTERNAL: a rejected GET propagates and nothing is posted', async () => {
    const c = {
      get: vi.fn(async (_path: string): Promise<unknown> => {
        throw new Error('offline');
      }),
      post: vi.fn(async (_path: string, _body: unknown) => ({})),
    };

    await expect(proveDevice(c, plainStore())).rejects.toThrow('offline');
    expect(c.post).not.toHaveBeenCalled();
  });

  it('EXTERNAL: a rejected POST propagates', async () => {
    // The real ones: an expired nonce (401), or a 409 for an id that already
    // registered a different key.
    const c = {
      get: vi.fn(async (_path: string) => ({ nonce: NONCE })),
      post: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => {
        throw new Error('409 device key already registered');
      }),
    };

    await expect(proveDevice(c, plainStore())).rejects.toThrow(/already registered/);
  });

  it('EXTERNAL: an unreadable key store propagates and nothing is asked for', async () => {
    /*
     * A store that throws must not become "no key yet" — that swallow is what
     * minted a new identity on every transient failure. Here it must also mean
     * no nonce is spent.
     */
    const broken: SecureStoreLike = {
      getItem: async () => {
        throw new Error('keychain unavailable');
      },
      setItem: async () => {},
    };
    const c = client({ nonce: NONCE });

    await expect(proveDevice(c, broken)).rejects.toThrow(/refusing to generate a new identity/);
    expect(c.get).not.toHaveBeenCalled();
    expect(c.post).not.toHaveBeenCalled();
  });
});
