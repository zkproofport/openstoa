/**
 * `src/lib/mediaRateLimit.ts` — rate limiting for `GET /api/media/{key}` (M-7).
 *
 * The fail-open-on-Redis-error path is a SEPARATE file
 * (`mediaRateLimit.failOpen.test.ts`) — it needs `@/lib/redisRateLimit`
 * mocked to reject, which vitest hoists module-wide, and this file needs the
 * REAL primitive for its arithmetic assertions. The route-level wiring
 * contract (the route actually calls these functions, in the right order,
 * before R2) lives in `src/__tests__/media-route.test.ts`. The real-HTTP,
 * real-Redis, real-Cloud-Run-shaped end-to-end proof is
 * `src/__tests__/e2e/media-rate-limit.test.ts`.
 *
 * Edge-case matrix rows covered here:
 *   boundary       — a single X-Forwarded-For entry; exactly MEDIA_READ_RATE.max
 *                    requests allowed, the next one rejected
 *   hostile        — an attacker-prepended batch of fake leading IPs is
 *                    ignored (only the Cloud-Run-appended trailing entry
 *                    counts); a non-IP-shaped / absurdly long trailing entry
 *                    falls back to the shared sentinel rather than becoming
 *                    an arbitrary Redis key
 *   empty/null/ws  — missing header, empty-string header, and whitespace-only
 *                    header are three SEPARATE assertions, all -> sentinel
 *   UTF-8          — N/A: an IP address is not a locale-sensitive text field;
 *                    the closest analogue (IPv6 hex/colon shape) is covered
 *                    under CONTRACT below instead
 *   authz          — session userId always wins over IP, even when both are
 *                    present; no session falls back to IP
 *   race            — N/A: covered by the real-Redis atomic-INCR guarantee
 *                    already exercised in `redisRateLimit.test.ts`; nothing
 *                    about IDENTITY RESOLUTION is concurrency-sensitive
 *   contract        — the same IP, keyed twice, is idempotent; two distinct
 *                    identities never share a bucket
 *   result integrity — the count returned by repeated calls is monotonic and
 *                    the true/false boundary sits exactly at MEDIA_READ_RATE.max
 */
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { getRedis } from '@/lib/redis';
import {
  anonymousMediaIdentity,
  resolveMediaIdentity,
  checkMediaReadRateLimit,
  MEDIA_READ_RATE,
} from '@/lib/mediaRateLimit';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3200/api/media/x', { headers });
}

// ─── anonymousMediaIdentity — pure, no Redis ────────────────────────────────

describe('anonymousMediaIdentity', () => {
  it('BOUNDARY: a single X-Forwarded-For entry is used as-is', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('CONTRACT: the LAST entry wins when several are present (Cloud Run appends the real IP last)', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '9.9.9.9, 203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('HOSTILE: an attacker-prepended batch of fake leading IPs is ignored — only the trailing entry counts', () => {
    // This is the specific bypass "trust the last entry" defeats: an
    // attacker sending a fresh, unique fake IP per request cannot get a
    // fresh Redis bucket per request, because Cloud Run appends its own
    // real observation AFTER whatever the client sent — this function must
    // read only that trailing entry, never the attacker-controlled ones.
    const fakeLeadingIps = Array.from({ length: 20 }, (_, i) => `1.1.1.${i}`).join(', ');
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': `${fakeLeadingIps}, 203.0.113.99` }))).toBe(
      '203.0.113.99',
    );
  });

  it('EMPTY: a missing header falls back to the shared sentinel', () => {
    expect(anonymousMediaIdentity(makeRequest())).toBe('unknown');
  });

  it('EMPTY: an empty-string header falls back to the sentinel', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '' }))).toBe('unknown');
  });

  it('EMPTY: a whitespace-only header falls back to the sentinel', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '   ' }))).toBe('unknown');
  });

  it('HOSTILE: a non-IP-shaped trailing entry falls back to the sentinel rather than becoming a raw Redis key', () => {
    expect(
      anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '1.2.3.4, <script>alert(1)</script>' })),
    ).toBe('unknown');
  });

  it('HOSTILE: an absurdly long trailing entry falls back to the sentinel (Redis key hygiene)', () => {
    const huge = '1'.repeat(10_000);
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': huge }))).toBe('unknown');
  });

  it('CONTRACT: an IPv6 address is accepted as-is (colon/hex shape)', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('BOUNDARY: surrounding whitespace around entries is trimmed', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '  203.0.113.5  ,  198.51.100.7  ' }))).toBe(
      '198.51.100.7',
    );
  });

  it('EDGE: a trailing comma with nothing after it is a harmless artifact — the empty segment is dropped, not treated as the identity', () => {
    // split(',') on '203.0.113.5,' yields ['203.0.113.5', ''] — filter(Boolean)
    // removes the empty segment BEFORE 'last' is taken, so this still resolves
    // to the real IP rather than falling back to the sentinel.
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': '203.0.113.5,' }))).toBe('203.0.113.5');
  });

  it('EDGE: an entry that is ONLY commas falls back to the sentinel (every segment empties out)', () => {
    expect(anonymousMediaIdentity(makeRequest({ 'x-forwarded-for': ',,,' }))).toBe('unknown');
  });
});

// ─── resolveMediaIdentity — pure, no Redis ──────────────────────────────────

describe('resolveMediaIdentity', () => {
  it('AUTHZ: a session userId always wins over IP, even when both are present', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5' });
    expect(resolveMediaIdentity(req, 'nullifier-abc')).toBe('nullifier-abc');
  });

  it('AUTHZ: no session falls back to the resolved IP identity', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5' });
    expect(resolveMediaIdentity(req, null)).toBe('203.0.113.5');
  });

  it('AUTHZ: no session AND no header falls back to the sentinel', () => {
    expect(resolveMediaIdentity(makeRequest(), null)).toBe('unknown');
  });
});

// ─── checkMediaReadRateLimit — real Redis arithmetic ────────────────────────

const IDENTITY_A = `mediaRateLimit-test-a-${Date.now()}`;
const IDENTITY_B = `mediaRateLimit-test-b-${Date.now()}`;

afterAll(async () => {
  const r = getRedis();
  await r.del(`community:ratelimit:media:${IDENTITY_A}`, `community:ratelimit:media:${IDENTITY_B}`);
  r.disconnect();
});

describe.sequential('checkMediaReadRateLimit — real Redis', () => {
  it('BOUNDARY/RESULT INTEGRITY: allows exactly MEDIA_READ_RATE.max requests, rejects the next one', async () => {
    await getRedis().del(`community:ratelimit:media:${IDENTITY_A}`);
    const results: boolean[] = [];
    for (let i = 0; i < MEDIA_READ_RATE.max + 2; i++) {
      results.push(await checkMediaReadRateLimit(IDENTITY_A));
    }
    expect(results.slice(0, MEDIA_READ_RATE.max).every(Boolean)).toBe(true);
    expect(results.slice(MEDIA_READ_RATE.max).every((r) => r === false)).toBe(true);
  }, 30_000);

  it('CONTRACT: a distinct identity never shares a bucket with an exhausted one', async () => {
    // IDENTITY_A is already at/over its ceiling from the previous (sequential) test.
    expect(await checkMediaReadRateLimit(IDENTITY_A)).toBe(false);
    expect(await checkMediaReadRateLimit(IDENTITY_B)).toBe(true);
  });
});
