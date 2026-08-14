/**
 * The Redis primitive behind every fixed-window rate limiter in this app:
 * INCR the window's counter, EXPIRE it on first touch, compare to a ceiling.
 *
 * Extracted out of `src/lib/mls/http.ts` (M-7) so the media-read limiter
 * (`src/lib/mediaRateLimit.ts`, per-IP/per-session, unauthenticated-capable)
 * can share this exact logic with the MLS per-member write limiters
 * (`checkRateLimit`, 13 call sites, always authenticated) without either
 * duplicating the Redis calls or pulling media-route code through a module
 * whose own doc comment scopes it to "the MLS Delivery Service endpoints."
 * The two callers differ only in what IDENTITY they key on and what they do
 * when Redis itself is unreachable — both decisions live in the caller, not
 * here.
 */
import { getRedis } from '@/lib/redis';

/**
 * Increment the counter at `key` and return its new value, setting the
 * key's TTL to `windowSec` the first time it is created (fixed-window, not
 * sliding — a burst straddling the window boundary can briefly allow up to
 * 2x the ceiling, an accepted trade-off shared with the pre-existing MLS
 * limiters this factors out of).
 */
export async function incrementRateWindow(key: string, windowSec: number): Promise<number> {
  const redis = getRedis();
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, windowSec);
  }
  return n;
}
