/**
 * `checkMediaReadRateLimit` — EXTERNAL-DEPENDENCY-FAILURE row of the M-7
 * matrix, in its own file because it needs `@/lib/redisRateLimit` MOCKED to
 * reject (vitest hoists `vi.mock` module-wide, which would break the
 * real-Redis arithmetic assertions in `mediaRateLimit.test.ts` if they
 * shared a file).
 *
 * A rejected promise from `incrementRateWindow` is exactly the shape a real
 * Redis outage produces (connection refused/reset, `REDIS_URL` unset,
 * `redis.incr()` timing out and rejecting) — this models the real refusal,
 * not a lenient stand-in.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/redisRateLimit', () => ({
  incrementRateWindow: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkMediaReadRateLimit } from '@/lib/mediaRateLimit';

describe('checkMediaReadRateLimit — Redis unreachable', () => {
  it('EXTERNAL-DEPENDENCY-FAILURE: fails OPEN — a Redis error allows the request through', async () => {
    // Deliberately the OPPOSITE contract of every `checkRateLimit` caller in
    // `src/lib/mls/http.ts` (those fail closed — see that module's own
    // tests). This is a public, unauthenticated-capable READ path that
    // never depended on Redis before M-7; failing closed here would let a
    // Redis blip take down every image on the site, including the OG cards
    // just wired up for crawlers.
    const allowed = await checkMediaReadRateLimit('some-identity');
    expect(allowed).toBe(true);
  });

  it('stays open across repeated calls — not a one-shot fluke of mock ordering', async () => {
    await expect(checkMediaReadRateLimit('identity-1')).resolves.toBe(true);
    await expect(checkMediaReadRateLimit('identity-2')).resolves.toBe(true);
    await expect(checkMediaReadRateLimit('identity-1')).resolves.toBe(true);
  });
});
