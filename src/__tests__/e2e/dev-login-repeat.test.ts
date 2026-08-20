/**
 * `dev-login` works more than once per name.
 *
 * It did not. `userId` is minted fresh on every request and the existence check
 * looked it up BY THAT ID, so the lookup never matched and the insert always
 * ran — while `users.nickname` carries a unique constraint. The second call
 * with any given name died on the constraint and answered 500 with an errorId.
 *
 * An endpoint whose entire purpose is repeatable testing worked exactly once
 * per name, and the failure looked like a server fault rather than a misuse.
 * It surfaced while setting up a two-device key-delivery run: sign in as the
 * same person on a second client, get a 500.
 *
 * Real HTTP against the running container (CLAUDE.md: E2E hits real
 * containers), because the defect is a database constraint — a mocked db is
 * exactly the thing that cannot reproduce it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the same name twice returns the SAME userId and a usable token
 *   integrity  → the reused session really is that account: it can read its own
 *                profile, and the nickname comes back unchanged
 *   boundary   → no name at all still mints a NEW account every time, which is
 *                what suites needing their own identity rely on
 *   empty      → an empty or whitespace-only name is treated as no name, not as
 *                an account literally called ""
 *   very large → a name past the cap is a 400, not a 500 and not a silent trim
 *   UTF-8      → a Korean/emoji name round-trips and is reusable
 *   race       → two simultaneous calls for one NEW name both succeed on the
 *                same account rather than one of them 500ing
 *   hostile    → a non-string nickname falls back to a generated one
 *   authz      → N/A: the endpoint is gated on APP_ENV !== production, which is
 *                a deploy-time property this suite cannot assert from inside.
 */
import { describe, it, expect } from 'vitest';

const BASE = process.env.OPENSTOA_E2E_BASE_URL ?? 'http://127.0.0.1:3200';

interface DevLogin {
  userId?: string;
  nickname?: string;
  token?: string;
  error?: string;
}

async function devLogin(body: unknown): Promise<{ status: number; json: DevLogin }> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as DevLogin };
}

/** A name nothing else in the suite will collide with. */
const unique = (label: string) => `dlr_${label}_${Math.floor(performance.now() * 1000)}`;

describe('dev-login — repeatable by name', () => {
  it('CONTRACT: the same name twice is the same account', async () => {
    const name = unique('same');

    const first = await devLogin({ nickname: name });
    const second = await devLogin({ nickname: name });

    expect(first.status, `first: ${JSON.stringify(first.json)}`).toBe(200);
    expect(second.status, `second: ${JSON.stringify(second.json)}`).toBe(200);
    expect(second.json.userId).toBe(first.json.userId);
    expect(second.json.nickname).toBe(name);
    expect(second.json.token, 'the reused login returned no token').toBeTruthy();
  });

  it('INTEGRITY: the reused token really is that account', async () => {
    // Same id in the response is not enough — the session has to work.
    const name = unique('session');
    await devLogin({ nickname: name });
    const again = await devLogin({ nickname: name });

    const res = await fetch(`${BASE}/api/profile/badges`, {
      headers: { Authorization: `Bearer ${again.json.token}` },
    });

    expect(res.status, 'the reused token was not accepted').toBeLessThan(400);
  });

  it('BOUNDARY: no name mints a new account each time', async () => {
    // What a suite that wants an identity of its own depends on.
    const a = await devLogin({});
    const b = await devLogin({});

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json.userId).not.toBe(a.json.userId);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('EMPTY: %s is treated as no name, not as an account called ""', async (_label, nickname) => {
    const a = await devLogin({ nickname });
    const b = await devLogin({ nickname });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.nickname?.startsWith('dev_user_')).toBe(true);
    expect(b.json.userId).not.toBe(a.json.userId);
  });

  it('HOSTILE: a non-string nickname falls back rather than failing', async () => {
    const res = await devLogin({ nickname: 42 });

    expect(res.status).toBe(200);
    expect(res.json.nickname?.startsWith('dev_user_')).toBe(true);
  });

  it('VERY LARGE: a name past the cap is refused with 400, not 500', async () => {
    // The distinction matters: 500 reads as "the server is broken" and sends
    // whoever hit it looking for a fault that is not there.
    const res = await devLogin({ nickname: 'x'.repeat(500) });

    expect(res.status).toBe(400);
    expect(res.json.error).toBeTruthy();
  });

  it('UTF-8: a Korean and emoji name round-trips, and is reusable', async () => {
    const name = `${unique('utf8')}_한글🎉`;

    const first = await devLogin({ nickname: name });
    const second = await devLogin({ nickname: name });

    expect(first.status).toBe(200);
    expect(first.json.nickname).toBe(name);
    expect(second.json.userId).toBe(first.json.userId);
  });

  it('RACE: two simultaneous first-logins for one name both land on it', async () => {
    /*
     * Both callers pass the existence check before either insert commits, so
     * without the retry one of them takes the constraint violation and 500s.
     * Two devices signing in as the same person at once is not exotic — it is
     * the setup for every key-delivery test.
     */
    const name = unique('race');

    const [a, b] = await Promise.all([
      devLogin({ nickname: name }),
      devLogin({ nickname: name }),
    ]);

    expect(a.status, `a: ${JSON.stringify(a.json)}`).toBe(200);
    expect(b.status, `b: ${JSON.stringify(b.json)}`).toBe(200);
    expect(a.json.userId).toBe(b.json.userId);
  });
});
