/**
 * SI-4 anti-DoS: per-member rate limiting + input validation for MLS uploads.
 * Rate limit is exercised against real local Redis (REDIS_URL or default).
 */
import { describe, it, expect, afterAll } from 'vitest';

// The docblock above promises "REDIS_URL or default", but `@/lib/redis` has no
// fallback by design (CLAUDE.md forbids env fallbacks in app code) — so without
// this the file threw `REDIS_URL environment variable is required` in any shell
// that had not exported it. The default belongs HERE, in the test, exactly like
// push.test.ts / pushPrefs.test.ts default DATABASE_URL.
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { getRedis } from '@/lib/redis';
import {
  checkRateLimit,
  decodeBase64Strict,
  MLS_MAX_KEY_PACKAGE_BYTES,
  MLS_MAX_COMMIT_BYTES,
} from '@/lib/mls/http';

const ACTION = 'si4-test';
const USER = 'si4-test-user';
const KEY = `mls:rate:${ACTION}:${USER}`;

afterAll(async () => {
  const r = getRedis();
  await r.del(KEY);
  r.disconnect();
});

describe('SI-4 — per-member rate limit (real Redis)', () => {
  it('allows up to max within the window, then rejects', async () => {
    await getRedis().del(KEY);
    const limit = { max: 3, windowSec: 60 };
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit(ACTION, USER, limit));
    expect(results).toEqual([true, true, true, false, false]);
  });
});

describe('MLS upload input validation (decodeBase64Strict + caps)', () => {
  it('accepts canonical base64 and round-trips bytes', () => {
    const buf = decodeBase64Strict(Buffer.from('hello-mls').toString('base64'));
    expect(buf).not.toBeNull();
    expect(buf!.toString()).toBe('hello-mls');
  });

  it('rejects non-base64 / non-canonical / empty input', () => {
    expect(decodeBase64Strict('not base64!!')).toBeNull();
    expect(decodeBase64Strict('')).toBeNull();
    expect(decodeBase64Strict(123 as unknown)).toBeNull();
    expect(decodeBase64Strict('AAA')).toBeNull(); // length not multiple of 4
  });

  it('size caps are sane and ordered (KeyPackage < Commit budget)', () => {
    expect(MLS_MAX_KEY_PACKAGE_BYTES).toBeGreaterThan(0);
    expect(MLS_MAX_COMMIT_BYTES).toBeGreaterThanOrEqual(MLS_MAX_KEY_PACKAGE_BYTES);
  });
});
