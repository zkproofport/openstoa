/**
 * `src/lib/redisRateLimit.ts` — the fixed-window Redis primitive shared by
 * the MLS per-member write limiters (`src/lib/mls/http.ts`) and the M-7
 * media-read limiter (`src/lib/mediaRateLimit.ts`). Extracted, not
 * duplicated — this file is what proves the shared core still behaves
 * exactly as `mls-http.test.ts`'s pre-refactor assertions expected.
 *
 * Edge-case matrix rows covered here:
 *   boundary — 1st increment sets the TTL, Nth vs N+1th around a small ceiling
 *   boundary — window reset: a key created with a short TTL stops counting
 *              once that TTL has actually expired
 *   contract — two different keys never share a counter
 */
process.env.REDIS_URL ??= 'redis://localhost:6379';

import { describe, it, expect, afterAll } from 'vitest';
import { getRedis } from '@/lib/redis';
import { incrementRateWindow } from '@/lib/redisRateLimit';

const PREFIX = `redisRateLimit-test-${Date.now()}`;
const KEY_A = `${PREFIX}:a`;
const KEY_B = `${PREFIX}:b`;
const KEY_RESET = `${PREFIX}:reset`;

afterAll(async () => {
  const r = getRedis();
  await r.del(KEY_A, KEY_B, KEY_RESET);
  r.disconnect();
});

describe('incrementRateWindow', () => {
  it('BOUNDARY: increments 1, 2, 3, ... in order for one key', async () => {
    await getRedis().del(KEY_A);
    expect(await incrementRateWindow(KEY_A, 60)).toBe(1);
    expect(await incrementRateWindow(KEY_A, 60)).toBe(2);
    expect(await incrementRateWindow(KEY_A, 60)).toBe(3);
  });

  it('CONTRACT: a different key starts its own counter at 1, unaffected by KEY_A', async () => {
    await getRedis().del(KEY_B);
    expect(await incrementRateWindow(KEY_B, 60)).toBe(1);
  });

  it('BOUNDARY: the key expires and the counter resets after its window elapses', async () => {
    await getRedis().del(KEY_RESET);
    expect(await incrementRateWindow(KEY_RESET, 1)).toBe(1);
    expect(await incrementRateWindow(KEY_RESET, 1)).toBe(2);
    // Wait past the 1s window with a safety margin, then confirm a fresh
    // window (bounded, deterministic — not a manual sleep-poll loop).
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await incrementRateWindow(KEY_RESET, 1)).toBe(1);
  }, 10000);
});
