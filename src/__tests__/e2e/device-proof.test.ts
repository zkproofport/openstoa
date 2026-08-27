/**
 * Proving a device by a key it holds — over real HTTP against a running container.
 *
 * WHY THIS EXISTS AS AN E2E, and why the unit tests are not enough. The proof
 * spans four things that only meet in a deployed server: the nonce in Redis, the
 * Ed25519 verification, the `device_signing_keys` row, and the device id read
 * from a header. Each has a unit test. None of them proves they are wired to
 * each other — and "wired to nothing" is precisely the defect that produced this
 * whole branch: a recovery sheet with passing tests that no screen rendered, and
 * a `device_signing_keys` table that no client ever wrote to.
 *
 * THE CURVE IS REAL HERE. Node's own Ed25519 signs the nonce, and the server
 * verifies with its own code. A stub that returns a constant would pass a test
 * that proves nothing about whether these two halves agree on what is being
 * signed — which is exactly the bug shape (sign the base64 text on one side,
 * the decoded bytes on the other) that produces a signature verifying nowhere.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   authz     → no session: both verbs refuse
 *   contract  → a correct signature registers, and says so
 *   contract  → the SAME device proving again is 'proved', not a second row
 *   integrity → a nonce is spendable exactly once, even with a correct signature
 *   integrity → a nonce issued to one account cannot be spent by another
 *   hostile   → a wrong signature is refused, AND still burns the nonce
 *   hostile   → a signature over the base64 TEXT (not the bytes) is refused
 *   hostile   → the same device id presenting a different key is 409, not a
 *               silent overwrite
 *   boundary  → missing / empty / non-string fields are 400, never a 500
 *   race      → N proofs of the same key leave the account with one identity
 */
import { describe, it, expect } from 'vitest';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { getBaseUrl } from './helpers';

const BASE = getBaseUrl();
const PATH = `${BASE}/api/auth/device/challenge`;

function deviceId(tag: string): string {
  return `e2e-dp-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function name(tag: string): string {
  return `e2e_dp_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * An Ed25519 identity in the shape the client sends: raw 32-byte key, base64.
 *
 * Node hands out DER, so the last 32 bytes of the SPKI are taken — the same
 * slice the server's `deviceProof.ts` reverses when it prepends the fixed header
 * to verify. Doing it here rather than trusting a helper means the test would
 * catch the two sides drifting on the encoding.
 */
function makeKey(): { publicKey: string; sign: (nonceB64: string) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return {
    publicKey: raw.toString('base64'),
    // Signed over the DECODED nonce bytes, which is what the route documents.
    sign: (nonceB64: string) =>
      sign(null, Buffer.from(nonceB64, 'base64'), privateKey).toString('base64'),
  };
}

async function signIn(opts: { nickname: string; device: string }): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openstoa-device-kind': 'mobile',
      'x-openstoa-device-id': opts.device,
    },
    body: JSON.stringify({ nickname: opts.nickname }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`dev-login gave no token (status ${res.status})`);
  return body.token;
}

function authHeaders(token: string, device: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-openstoa-device-kind': 'mobile',
    'x-openstoa-device-id': device,
  };
}

async function getNonce(token: string, device: string): Promise<string> {
  const res = await fetch(PATH, { headers: authHeaders(token, device) });
  const body = (await res.json()) as { nonce?: string };
  if (!body.nonce) throw new Error(`no nonce (status ${res.status})`);
  return body.nonce;
}

async function answer(
  token: string,
  device: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(PATH, {
    method: 'POST',
    headers: authHeaders(token, device),
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* a body we cannot read is still a status we can assert */
  }
  return { status: res.status, body };
}

/** Sign in, take a nonce, answer it correctly. The ordinary path, reused. */
async function proveOnce(
  token: string,
  device: string,
  key: ReturnType<typeof makeKey>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nonce = await getNonce(token, device);
  return answer(token, device, {
    nonce,
    signature: key.sign(nonce),
    publicKey: key.publicKey,
  });
}

describe('a device proves itself with a key, over HTTP', () => {
  it('AUTHZ: without a session neither verb answers', async () => {
    const dev = deviceId('anon');
    const got = await fetch(PATH, { headers: { 'x-openstoa-device-id': dev } });
    expect(got.status).toBe(401);

    const posted = await fetch(PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openstoa-device-id': dev },
      body: JSON.stringify({ nonce: 'x', signature: 'y', publicKey: 'z' }),
    });
    expect(posted.status).toBe(401);
  });

  it('CONTRACT: a correct signature registers the key', async () => {
    const dev = deviceId('reg');
    const token = await signIn({ nickname: name('reg'), device: dev });
    const res = await proveOnce(token, dev, makeKey());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('registered');
  });

  it('RACE: proving the same key N times leaves ONE identity, not N', async () => {
    /*
     * The accumulating axis, and the reason this file is not a single happy
     * path. A route that INSERTED on every proof would pass a one-call test and
     * give the account a new device row per app launch — which is the exact
     * shape of the 48-ghost-leaf defect this branch exists to end. Only the
     * first answer may say 'registered'; every later one is 'proved'.
     */
    const dev = deviceId('rep');
    const token = await signIn({ nickname: name('rep'), device: dev });
    const key = makeKey();

    const seen: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await proveOnce(token, dev, key);
      expect(r.status).toBe(200);
      seen.push(r.body.status);
    }

    expect(seen[0]).toBe('registered');
    expect(seen.slice(1)).toEqual(['proved', 'proved', 'proved', 'proved']);
  });

  it('INTEGRITY: a nonce is spendable exactly once', async () => {
    // Replay is the whole reason a nonce exists. A captured answer must not be
    // a password that works again tomorrow.
    const dev = deviceId('replay');
    const token = await signIn({ nickname: name('replay'), device: dev });
    const key = makeKey();
    const nonce = await getNonce(token, dev);
    const payload = { nonce, signature: key.sign(nonce), publicKey: key.publicKey };

    expect((await answer(token, dev, payload)).status).toBe(200);
    // Byte-for-byte the same, correct, answer — and it must fail now.
    expect((await answer(token, dev, payload)).status).toBe(401);
  });

  it('HOSTILE: a wrong signature is refused AND burns the nonce', async () => {
    /*
     * Burning it is the point. If a bad answer left the challenge alive the
     * endpoint would be an oracle — keep the nonce, keep guessing. The route
     * spends it BEFORE it verifies for exactly this reason, so the retry with a
     * CORRECT signature must also fail.
     */
    const dev = deviceId('badsig');
    const token = await signIn({ nickname: name('badsig'), device: dev });
    const key = makeKey();
    const other = makeKey();
    const nonce = await getNonce(token, dev);

    const wrong = await answer(token, dev, {
      nonce,
      signature: other.sign(nonce), // right shape, wrong key
      publicKey: key.publicKey,
    });
    expect(wrong.status).toBe(403);

    const retry = await answer(token, dev, {
      nonce,
      signature: key.sign(nonce), // now correct — and still refused
      publicKey: key.publicKey,
    });
    expect(retry.status).toBe(401);
  });

  it('HOSTILE: signing the base64 TEXT instead of the bytes does not verify', async () => {
    /*
     * The encoding bug this catches produces a signature that verifies nowhere
     * and a failure that looks like a wrong key — hours of looking in the wrong
     * place. Named here so the next person reads the answer instead of finding
     * it.
     */
    const dev = deviceId('enc');
    const token = await signIn({ nickname: name('enc'), device: dev });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const nonce = await getNonce(token, dev);

    const res = await answer(token, dev, {
      nonce,
      signature: sign(null, Buffer.from(nonce, 'utf8'), privateKey).toString('base64'),
      publicKey: spki.subarray(spki.length - 32).toString('base64'),
    });
    expect(res.status).toBe(403);
  });

  it('HOSTILE: the same device id presenting a DIFFERENT key is 409', async () => {
    /*
     * Not an overwrite. The row is the account's memory of which device this is;
     * replacing it silently would let anything that reaches the endpoint rewrite
     * that memory, and the takeover warning would then be computed from the
     * attacker's grouping.
     */
    const dev = deviceId('swap');
    const token = await signIn({ nickname: name('swap'), device: dev });

    expect((await proveOnce(token, dev, makeKey())).status).toBe(200);
    const swapped = await proveOnce(token, dev, makeKey());
    expect(swapped.status).toBe(409);
  });

  it('INTEGRITY: a nonce issued to one account cannot be spent by another', async () => {
    // Nonces are stored against the account they were issued to. Without that,
    // any signed-in caller could answer a challenge meant for someone else.
    const devA = deviceId('a');
    const devB = deviceId('b');
    const tokenA = await signIn({ nickname: name('nA'), device: devA });
    const tokenB = await signIn({ nickname: name('nB'), device: devB });
    const key = makeKey();

    const nonce = await getNonce(tokenA, devA);
    const stolen = await answer(tokenB, devB, {
      nonce,
      signature: key.sign(nonce),
      publicKey: key.publicKey,
    });
    expect(stolen.status).toBe(401);
  });

  it.each([
    ['nothing at all', {}],
    ['no signature', { nonce: 'aaaa', publicKey: 'bbbb' }],
    ['no publicKey', { nonce: 'aaaa', signature: 'bbbb' }],
    ['empty strings', { nonce: '', signature: '', publicKey: '' }],
    ['numbers instead of strings', { nonce: 1, signature: 2, publicKey: 3 }],
    ['nulls', { nonce: null, signature: null, publicKey: null }],
  ])('BOUNDARY: %s is 400, never a 500', async (_label, payload) => {
    const dev = deviceId('bad');
    const token = await signIn({ nickname: name('bad'), device: dev });
    const res = await answer(token, dev, payload as Record<string, unknown>);
    expect(res.status).toBe(400);
  });

  it('BOUNDARY: a body that is not JSON at all is 400', async () => {
    const dev = deviceId('nojson');
    const token = await signIn({ nickname: name('nojson'), device: dev });
    const res = await fetch(PATH, {
      method: 'POST',
      headers: authHeaders(token, dev),
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('BOUNDARY: two nonces issued in a row are different values', async () => {
    // A constant would make every "one nonce, one answer" assertion above
    // vacuous, and this is the cheapest place to notice.
    const dev = deviceId('two');
    const token = await signIn({ nickname: name('two'), device: dev });
    const first = await getNonce(token, dev);
    const second = await getNonce(token, dev);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(16);
  });
});
