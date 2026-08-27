/**
 * One phone whose install id changed is still one phone — over real HTTP.
 *
 * THE DEFECT, measured on staging. One account, one physical phone, and
 * `mls_device_joins` held 48 device ids for a single private room. The phone had
 * made itself a stranger 47 times over, so it read its own messages as "Waiting
 * for the key…" and the one-device rule warned it about "your other device" on
 * every sign-in — the other device being itself.
 *
 * THE FIX THIS GUARDS. The install id is a random value in a store that can be
 * cleared; a KEY is not. Two ids that map to one registered public key are one
 * device. That claim spans the header the client sends, the `device_signing_keys`
 * rows, and the takeover gate's grouping — three modules whose unit tests all
 * pass while nothing connects them. This file is the only thing that can see
 * whether they are connected.
 *
 * WHAT IT DOES *NOT* CLAIM, and the code says the same thing in more words: a
 * signature proves CONTINUITY, never what kind of thing is holding the key. A
 * browser can make a keypair too. `deviceKind` is a separate question and is
 * still decided by the declared kind, which `one-device.test.ts` covers.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → a NEW install id presenting a REGISTERED key is not a second phone
 *   integrity → a new install id with a DIFFERENT key still conflicts (409)
 *   integrity → an unregistered key does not group — the grouping needs a proof
 *   boundary  → no key at all behaves exactly as it did before keys existed
 *   hostile   → a malformed key header is ignored, not honoured, and not a 500
 *   race      → N reinstalls in a row leave the account with ONE live session
 *   boundary  → NO device id at all: two such callers are two devices, not one
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getBaseUrl } from './helpers';

const BASE = getBaseUrl();

function deviceId(tag: string): string {
  return `e2e-grp-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function name(tag: string): string {
  return `e2e_grp_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function makeKey(): { publicKey: string; sign: (nonceB64: string) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    publicKey: spki.subarray(spki.length - 32).toString('base64'),
    sign: (nonceB64: string) =>
      sign(null, Buffer.from(nonceB64, 'base64'), privateKey).toString('base64'),
  };
}

interface LoginResult {
  status: number;
  token?: string;
}

/**
 * Sign in, optionally presenting a device key.
 *
 * `publicKey === undefined` omits the header entirely rather than sending an
 * empty one — the two are different cases and the second is the one that would
 * quietly group every phone on the account together.
 */
async function login(opts: {
  nickname: string;
  device: string;
  publicKey?: string;
}): Promise<LoginResult> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openstoa-device-kind': 'mobile',
      'x-openstoa-device-id': opts.device,
      ...(opts.publicKey === undefined ? {} : { 'x-openstoa-device-key': opts.publicKey }),
    },
    body: JSON.stringify({ nickname: opts.nickname }),
  });
  let token: string | undefined;
  try {
    token = ((await res.json()) as { token?: string }).token;
  } catch {
    /* status is the assertion */
  }
  return { status: res.status, token };
}

/** Register a key against the signed-in account and this install id. */
async function register(
  token: string,
  device: string,
  key: ReturnType<typeof makeKey>,
): Promise<number> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-openstoa-device-kind': 'mobile',
    'x-openstoa-device-id': device,
  };
  const issued = await fetch(`${BASE}/api/auth/device/challenge`, { headers });
  const { nonce } = (await issued.json()) as { nonce: string };
  const res = await fetch(`${BASE}/api/auth/device/challenge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nonce, signature: key.sign(nonce), publicKey: key.publicKey }),
  });
  return res.status;
}

/**
 * The whole story in one call: sign in, register a key, then come back as a
 * fresh install carrying the same key. Returns the second sign-in's status.
 */
async function reinstallCarryingKey(tag: string): Promise<{
  status: number;
  who: string;
  key: ReturnType<typeof makeKey>;
}> {
  const who = name(tag);
  const first = deviceId(`${tag}-1`);
  const key = makeKey();

  const a = await login({ nickname: who, device: first, publicKey: key.publicKey });
  expect(a.status).toBe(200);
  expect(await register(a.token!, first, key)).toBe(200);

  // A new install id, the way a cleared store or a reinstall produces one.
  const second = await login({ nickname: who, device: deviceId(`${tag}-2`), publicKey: key.publicKey });
  return { status: second.status, who, key };
}

describe('a key, not an install id, decides whether this is the same phone', () => {
  it('CONTRACT: a new install id carrying a REGISTERED key is not a second phone', async () => {
    // The defect, exactly: without this the person is asked to sign out a phone
    // that is the one in their hand.
    const { status } = await reinstallCarryingKey('same');
    expect(status).toBe(200);
  });

  it('RACE: five reinstalls in a row still leave ONE phone', async () => {
    /*
     * The accumulating axis. A single reinstall passing proves the lookup
     * happened once; it does not prove the grouping holds as rows pile up. The
     * failure this catches is a gate that matches only the MOST RECENT row, or
     * one that starts warning once the account has enough ids — which is what
     * 48 ghosts looked like from the inside.
     */
    const who = name('many');
    const key = makeKey();
    const first = deviceId('many-0');

    const a = await login({ nickname: who, device: first, publicKey: key.publicKey });
    expect(a.status).toBe(200);
    expect(await register(a.token!, first, key)).toBe(200);

    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const dev = deviceId(`many-${i}`);
      const r = await login({ nickname: who, device: dev, publicKey: key.publicKey });
      statuses.push(r.status);
      // Each new install registers the same key under its own id, as the real
      // client does on first launch — so the account really does accumulate rows.
      if (r.token) await register(r.token, dev, key);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });

  it('INTEGRITY: a new install id with a DIFFERENT key still conflicts', async () => {
    /*
     * The direction that must NOT be lost. Grouping exists to remove a false
     * warning, not to remove the warning — a genuine second phone has to be told
     * that taking over ends the first one's chat keys.
     */
    const who = name('diff');
    const first = deviceId('diff-1');
    const key = makeKey();

    const a = await login({ nickname: who, device: first, publicKey: key.publicKey });
    expect(a.status).toBe(200);
    expect(await register(a.token!, first, key)).toBe(200);

    const other = await login({
      nickname: who,
      device: deviceId('diff-2'),
      publicKey: makeKey().publicKey, // a different phone, a different key
    });
    expect(other.status).toBe(409);
  });

  it('INTEGRITY: an UNREGISTERED key does not group — the proof is what counts', async () => {
    /*
     * Presenting a key is a claim; the challenge round trip is what makes it a
     * fact. If a bare header were enough, the grouping could be steered by
     * anything that could set a header.
     */
    const who = name('unreg');
    const key = makeKey();

    // Note: NO `register` call. The key is presented but never proven.
    const a = await login({ nickname: who, device: deviceId('unreg-1'), publicKey: key.publicKey });
    expect(a.status).toBe(200);

    const b = await login({ nickname: who, device: deviceId('unreg-2'), publicKey: key.publicKey });
    expect(b.status).toBe(409);
  });

  it('BOUNDARY: with no key at all, behaviour is exactly what it was before keys', async () => {
    // The fallback has to stay honest: a client that never registers must still
    // get the old warning rather than a silent merge.
    const who = name('nokey');
    expect((await login({ nickname: who, device: deviceId('nokey-1') })).status).toBe(200);
    expect((await login({ nickname: who, device: deviceId('nokey-2') })).status).toBe(409);
  });

  it.each([
    ['too short', 'AAAA'],
    ['too long', 'A'.repeat(200)],
    ['not base64', '!!!!not base64 at all!!!!'],
    ['empty', ''],
    ['whitespace', '   '],
  ])('HOSTILE: a malformed key header (%s) is ignored, not honoured', async (_label, bad) => {
    /*
     * NOT LISTED HERE: a value containing a newline or control characters.
     * `fetch` refuses to build such a header at all — "Headers.append: ... is an
     * invalid header value" — so the request never leaves the test and the
     * server's handling of it cannot be observed over HTTP. Those shapes are
     * covered where they can be: `deviceKeyHeaderIsShapeChecked.test.ts` calls
     * `deviceFromRequest` with a hand-built Request. Recorded so the next person
     * does not re-add them here and conclude the server is broken.
     */
    /*
     * Ignored means "falls back to the id", NOT "matches everything". A value
     * that reached the comparison would either match nothing (harmless but
     * confusing) or — if the comparison were loosened one day — match every row.
     * Asserting the CONFLICT is what proves it was dropped rather than honoured.
     */
    const who = name('junk');
    const first = await login({ nickname: who, device: deviceId('junk-1'), publicKey: bad });
    expect(first.status).toBe(200);

    const second = await login({ nickname: who, device: deviceId('junk-2'), publicKey: bad });
    expect(second.status).toBe(409);
  });

  it('BOUNDARY: no device id at all — two such callers are TWO devices, not one', async () => {
    /*
     * THE DEFECT THIS CLOSES, found by asking "what about a client that sends no
     * id". The header-less case used to collapse to the constant `'unknown'`, so
     * every caller in that state shared ONE identity: two real phones neither of
     * which declared itself were merged, and the takeover warning — the sentence
     * that says the other phone's chat keys are about to be lost — never fired.
     *
     * Measured before the fix: two `mobile` sign-ins with no id header, same
     * account, both 200. The second should have been a conflict.
     *
     * A missing id means "not known", and two unknowns are not equal. The second
     * caller must be treated as a second device.
     */
    const who = name('noid');

    const first = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openstoa-device-kind': 'mobile' },
      body: JSON.stringify({ nickname: who }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openstoa-device-kind': 'mobile' },
      body: JSON.stringify({ nickname: who }),
    });
    expect(second.status).toBe(409);
  });

  it.each([
    ['an empty id', ''],
    ['whitespace only', '   '],
  ])('BOUNDARY: %s is treated as NO id, not as a shared one', async (_label, raw) => {
    // Control-character ids belong to the unit test for the same reason as the
    // key header above: `fetch` will not send them.
    /*
     * These three collapse to the empty string after stripping, which is the same
     * road as a missing header — and the same merge hazard. Checked separately
     * because "absent" and "present but empty" are different code paths and only
     * one of them was ever exercised.
     */
    const who = name('empty');
    const send = () =>
      fetch(`${BASE}/api/auth/dev-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-openstoa-device-kind': 'mobile',
          'x-openstoa-device-id': raw,
        },
        body: JSON.stringify({ nickname: who }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
  });

  it('BOUNDARY: a WEB caller with no id is still never a conflict', async () => {
    /*
     * The rule is about phones. A browser has no chat keys to lose, so making
     * the anonymous id distinct must not start refusing web sign-ins — that
     * would be the fix breaking a case it was never about.
     */
    const who = name('webnoid');
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE}/api/auth/dev-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-openstoa-device-kind': 'web' },
        body: JSON.stringify({ nickname: who }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('BOUNDARY: the same install id signing in twice is still not a conflict', async () => {
    // The pre-existing guarantee, re-checked here because the key lookup now
    // sits in front of it and could plausibly break it.
    const who = name('twice');
    const dev = deviceId('twice');
    const key = makeKey();
    expect((await login({ nickname: who, device: dev, publicKey: key.publicKey })).status).toBe(200);
    expect((await login({ nickname: who, device: dev, publicKey: key.publicKey })).status).toBe(200);
  });
});
