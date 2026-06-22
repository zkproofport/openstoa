/**
 * Shared HTTP helpers for the MLS Delivery Service endpoints.
 *
 * Covers SI-4 (anti-DoS): per-member rate limits + payload-size caps applied to
 * every MLS upload. NOTE (dev plan G8): a flood of individually-valid Commits
 * can still force epoch churn; size/rate caps do NOT stop that — a dedicated
 * committer-rate policy is a Phase 2/3 follow-up, tracked separately.
 */
import { getRedis } from '@/lib/redis';

// The single MLS ciphersuite for the whole system — RFC 9420 §17.1 MTI, fixed
// in Phase 0 (G6). Stored on each mls_groups row for forward compatibility.
export const MLS_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';

// Payload-size caps (decoded bytes). KeyPackages and Commits are larger than a
// chat ciphertext; Commit/Welcome grow with group size (still bounded).
export const MLS_MAX_KEY_PACKAGE_BYTES = 16 * 1024;
export const MLS_MAX_COMMIT_BYTES = 256 * 1024;
export const MLS_MAX_GROUP_INFO_BYTES = 256 * 1024;

export interface RateLimit {
  max: number;
  windowSec: number;
}

// Per-member fixed-window rate limits.
export const MLS_RATE_KEY_PACKAGE: RateLimit = { max: 120, windowSec: 60 };
export const MLS_RATE_COMMIT: RateLimit = { max: 60, windowSec: 60 };

/**
 * Fixed-window per-member rate limiter backed by Redis INCR + EXPIRE. Returns
 * true if the call is within budget, false if it should be rejected (429).
 */
export async function checkRateLimit(
  action: string,
  userId: string,
  limit: RateLimit,
): Promise<boolean> {
  const redis = getRedis();
  const key = `mls:rate:${action}:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, limit.windowSec);
  }
  return n <= limit.max;
}

/**
 * Strictly decode a canonical base64 string to a Buffer, or return null if the
 * input is malformed (non-base64 chars, bad padding, non-canonical). Mirrors
 * the chat route's decoder so MLS uploads reject sloppy input the same way.
 */
export function decodeBase64Strict(s: unknown): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  if (s.length % 4 !== 0) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) return null;
  return buf;
}
