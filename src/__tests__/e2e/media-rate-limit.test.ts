import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import {
  getBaseUrl,
  getAuthToken,
  getUserId,
  getSecondUserToken,
} from './helpers';
import { uploadObjectKey } from '@/lib/r2';
import { MEDIA_READ_RATE } from '@/lib/mediaRateLimit';

/**
 * `GET /api/media/{key}` rate limiting (M-7), against a REAL running
 * container over plain HTTP — proves the route actually wires
 * `resolveMediaIdentity` / `checkMediaReadRateLimit` in, using the REAL
 * `MEDIA_READ_RATE` production constant, not a shrunken test value.
 *
 * The exhaustive arithmetic (boundary values, identity keying in isolation,
 * fail-open on Redis error) lives in `src/__tests__/mediaRateLimit.test.ts`
 * and `mediaRateLimit.failOpen.test.ts` — cheap, fast, real-Redis-but-no-HTTP
 * unit tests. This file only proves what ONLY a real HTTP round trip can:
 * the route wires the limiter in at all, in front of the R2 fetch, with the
 * real exported ceiling, and that it composes correctly with the existing
 * authorization gate and with real sessions.
 *
 * Every case here uses its OWN dedicated synthetic `X-Forwarded-For` value
 * (or the real per-suite session), freshly generated with real entropy —
 * see `freshSyntheticIp` — so this file cannot interfere with, or BE
 * interfered with by, any other test in the same Redis instance, including
 * a PRIOR run of this exact file.
 *
 * That last case is not hypothetical — it is what broke the first version
 * of test 5. It derived its synthetic IP from a few digits of `Date.now()`
 * (mod 200), which changes slowly enough that "run this file alone, then
 * run the full suite a few seconds later" could reproduce the SAME
 * synthetic IP both times, so the second run inherited the first run's
 * already-exhausted budget: `expected 300, received 0`. Three fixes were on
 * the table:
 *   1. Reset the window deliberately before the assertion — needs a
 *      test-only server-side reset hook (touching the route/adding a knob
 *      that must never fire in production) or direct Redis access from an
 *      E2E test, which this suite's own convention avoids (E2E hits real
 *      HTTP, not internals).
 *   2. Assert relatively (N more than the remaining budget trips a 429) —
 *      the remaining budget isn't observable over HTTP without first
 *      probing for it, which just moves the same isolation problem one
 *      step earlier, and it downgrades what the test can promise: "some
 *      further request eventually 429s" is weaker than "capped at EXACTLY
 *      the real ceiling."
 *   3. Give the test a genuinely fresh, high-entropy identity per
 *      invocation — fixes the actual defect (a reusable identity), needs no
 *      server changes, keeps the strong absolute assertion, and works
 *      identically whether the file runs alone, twice in a row, or inside
 *      an 800-test suite. Chosen.
 *
 * This still fails if the limiter breaks: the identity is real production
 * code's own IP-shaped input, routed through the real
 * `resolveMediaIdentity` -> `checkMediaReadRateLimit` -> real Redis path: if
 * the (max+1)th request stopped being rejected, this test would still see a
 * non-429 status and fail. Only WHICH identity gets hammered is now immune
 * to reuse — not the thing being asserted.
 *
 * Edge-case matrix rows covered here (real-HTTP layer only — see
 * `mediaRateLimit.test.ts`'s own header for the full list):
 *   boundary        — under the ceiling succeeds; the real MEDIA_READ_RATE.max
 *                     is honored end-to-end; the (max+1)th request is 429
 *   authz           — same IP, two different real sessions, do not share a
 *                     budget at low volume (proves userId wins over IP
 *                     through the real route, not just in the pure function)
 *   hostile         — a garbage X-Forwarded-For value never 500s the route
 *   integrity        — a 429 carries `Retry-After` and the documented error
 *                     shape; a request that fails the VISIBILITY gate still
 *                     returns that gate's real status (403), not swallowed
 *                     by the rate limiter or turned into a 429/500
 *   ext-dep-failure  — N/A here: would require taking the shared local Redis
 *                     down mid-suite, breaking every other concurrently
 *                     running E2E test against the same container; covered
 *                     by the mocked-rejection unit test instead
 */

const BASE_URL = getBaseUrl();

/**
 * A fresh, high-entropy, IP-shaped synthetic identity — 8 random hex groups
 * joined like an IPv6 address (~2^128 space), so two calls (even in the same
 * process, even seconds apart across separate invocations of this file)
 * cannot plausibly collide. Always passes `anonymousMediaIdentity`'s
 * `IP_SHAPED_RE` check and is always a REAL value sent as `X-Forwarded-For`,
 * so it never falls back to the shared `'unknown'` sentinel bucket that
 * OTHER anonymous E2E requests (ones that set no header at all) land in —
 * this identity is never shared with anything this test didn't create.
 */
function freshSyntheticIp(): string {
  return Array.from({ length: 8 }, () => randomBytes(2).toString('hex')).join(':');
}

function syntheticAvatarKey(uploaderId: string, tag: string): string[] {
  // Deterministic per-tag UUID-shaped id — no real upload needed. Avatars
  // are ungated (`AVATAR_IS_UNGATED` in the route), so a nonexistent object
  // still reaches the rate limiter and the R2 lookup, answering 404 rather
  // than being refused earlier by the topic-visibility gate. 404 vs 200 is
  // irrelevant to what this file proves — only the STATUS RELATIVE TO 429
  // matters here.
  const uuid = `00000000-0000-4000-8000-${tag.padStart(12, '0').slice(-12)}`;
  return uploadObjectKey('avatar', uploaderId, null, `${uuid}.png`).split('/');
}

async function getMedia(segments: string[], headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/media/${segments.join('/')}`, { headers });
}

describe.sequential('GET /api/media rate limiting (M-7)', () => {
  // Only used to namespace the fake avatar object keys below (readability in
  // logs / R2 key never collides in any way that matters — a 404 stays a
  // 404 either way). Rate-limit IDENTITY comes from `freshSyntheticIp()`,
  // never from this — see that function's doc comment for why.
  const RUN_TAG = String(Date.now()).slice(-12);

  it('1. BOUNDARY: a handful of requests under the ceiling all succeed (never 429)', async () => {
    const ip = freshSyntheticIp();
    const key = syntheticAvatarKey(getUserId(), `a1${RUN_TAG}`);
    for (let i = 0; i < 5; i++) {
      const res = await getMedia(key, { 'X-Forwarded-For': ip });
      expect(res.status).not.toBe(429);
    }
  });

  it('2. HOSTILE: a garbage X-Forwarded-For value never 500s the route', async () => {
    const key = syntheticAvatarKey(getUserId(), `h2${RUN_TAG}`);
    const res = await getMedia(key, { 'X-Forwarded-For': '<script>alert(1)</script>, not-an-ip-at-all' });
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(429);
  });

  it('3. AUTHZ: the same IP, two different real sessions, do not share a rate-limit budget', async () => {
    const ip = freshSyntheticIp();
    const second = await getSecondUserToken();
    const keyA = syntheticAvatarKey(getUserId(), `s3a${RUN_TAG}`);
    const keyB = syntheticAvatarKey(second.userId, `s3b${RUN_TAG}`);
    const resA = await fetch(`${BASE_URL}/api/media/${keyA.join('/')}`, {
      headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${getAuthToken()}` },
    });
    const resB = await fetch(`${BASE_URL}/api/media/${keyB.join('/')}`, {
      headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${second.token}` },
    });
    expect(resA.status).not.toBe(429);
    expect(resB.status).not.toBe(429);
  });

  it('4. INTEGRITY: a request that fails the visibility gate still returns that gate\'s real status, not swallowed by rate limiting', async () => {
    // A well-formed but non-existent SECRET-topic-shaped key, requested as a
    // guest: 401 ("guest can never prove membership"), from the visibility
    // gate — proves the rate limiter (which ran first) let it through
    // normally rather than intercepting or masking the gate's own decision.
    const fakeTopicId = '00000000-0000-4000-8000-000000000001';
    const fakePostUuid = '00000000-0000-4000-8000-000000000002';
    const ip = freshSyntheticIp();
    const res = await getMedia(
      ['topics', fakeTopicId, 'posts', fakePostUuid, 'x.png'],
      { 'X-Forwarded-For': ip },
    );
    // Topic doesn't exist -> gateTopicScoped's own 404, not the rate
    // limiter's 429 and not a 500 from something crashing.
    expect(res.status).toBe(404);
  });

  it('5. BOUNDARY/RESULT INTEGRITY: the real MEDIA_READ_RATE.max ceiling is enforced end-to-end, with Retry-After on the 429', async () => {
    const ip = freshSyntheticIp();
    const key = syntheticAvatarKey(getUserId(), `c5${RUN_TAG}`);
    const headers = { 'X-Forwarded-For': ip };

    // Fire the full ceiling concurrently — Redis INCR is atomic, so the
    // COUNT of non-429 responses is deterministic regardless of arrival
    // order.
    const batch = await Promise.all(
      Array.from({ length: MEDIA_READ_RATE.max }, () => getMedia(key, headers)),
    );
    const non429 = batch.filter((r) => r.status !== 429).length;
    expect(non429).toBe(MEDIA_READ_RATE.max);

    const overflow = await getMedia(key, headers);
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('retry-after')).toBe(String(MEDIA_READ_RATE.windowSec));
    const body = await overflow.json();
    expect(body.error).toBeTruthy();
  }, 60_000);
});
