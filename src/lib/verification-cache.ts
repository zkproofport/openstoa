/**
 * Redis-based verification cache.
 *
 * Privacy-first design: NO personal information (domain, country, email) is stored in the database.
 * Verification status is cached in Redis with a 30-day TTL.
 * Only hashed values are stored for matching — originals cannot be recovered.
 *
 * Cache keys use CIRCUIT names (not topic proofType) because:
 * - google_workspace, microsoft_365, workspace all use the same circuit (oidc_domain_attestation)
 * - The proof itself doesn't distinguish between Google and Microsoft providers
 * - Domain matching is what actually matters for gated topics
 *
 * When the cache expires, the user must re-verify to join new gated topics.
 * Existing topic memberships (topicMembers table) are NOT affected by cache expiry.
 */

import crypto from 'crypto';
import { redis } from './redis';

const VERIFICATION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

const KEY_PREFIX = 'community:verification';

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

function cacheKey(userId: string, cacheType: string): string {
  return `${KEY_PREFIX}:${userId}:${cacheType}`;
}

/**
 * Map topic proofType → cache key type (circuit-based).
 * google_workspace / microsoft_365 / workspace all map to 'oidc_domain'.
 */
export function toCacheType(proofType: string): string {
  switch (proofType) {
    case 'google_workspace':
    case 'microsoft_365':
    case 'workspace':
      return 'oidc_domain';
    default:
      return proofType; // 'kyc', 'country'
  }
}

/**
 * Map circuit name → cache key type.
 * For login OIDC, use circuitToCacheTypeForLogin() instead.
 */
export function circuitToCacheType(circuit: string): string {
  switch (circuit) {
    case 'oidc_domain_attestation':
      return 'oidc_domain';
    case 'coinbase_country_attestation':
      return 'country';
    case 'coinbase_attestation':
      return 'kyc';
    default:
      return circuit;
  }
}

/**
 * Map circuit name → cache key for LOGIN context.
 * OIDC login (--login-google) caches as 'oidc_login', NOT 'oidc_domain'.
 * This prevents personal Gmail logins from satisfying workspace proof requirements.
 */
export function circuitToCacheTypeForLogin(circuit: string): string {
  switch (circuit) {
    case 'oidc_domain_attestation':
      return 'oidc_login'; // NOT oidc_domain — login ≠ workspace proof
    case 'coinbase_country_attestation':
      return 'country';
    case 'coinbase_attestation':
      return 'kyc';
    default:
      return circuit;
  }
}


export interface VerificationRecord {
  verifiedAt: number; // Unix timestamp ms
  expiresAt: number;  // Unix timestamp ms
  domainHash?: string;
  countryHash?: string;
}

/**
 * Save verification result to Redis cache.
 * Only hashed domain/country are stored — no PII.
 */
export async function saveVerificationCache(
  userId: string,
  cacheType: string,
  options?: { domain?: string; country?: string },
): Promise<void> {
  const now = Date.now();
  const record: VerificationRecord = {
    verifiedAt: now,
    expiresAt: now + VERIFICATION_TTL * 1000,
  };
  if (options?.domain) {
    record.domainHash = hashValue(options.domain);
  }
  if (options?.country) {
    record.countryHash = hashValue(options.country);
  }

  await redis.set(
    cacheKey(userId, cacheType),
    JSON.stringify(record),
    'EX',
    VERIFICATION_TTL,
  );
}

/**
 * Check if user has a valid (non-expired) verification.
 * Accepts topic proofType — automatically maps to circuit-based cache key.
 * For domain-gated topics, also checks the domain hash matches.
 */
export async function hasValidVerificationCache(
  userId: string,
  proofType: string,
  requiredDomain?: string,
): Promise<boolean> {
  const ct = toCacheType(proofType);
  const data = await redis.get(cacheKey(userId, ct));
  if (!data) return false;

  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return false;

  // If a specific domain is required, check hash match
  if (requiredDomain) {
    if (!record.domainHash) return false;
    return record.domainHash === hashValue(requiredDomain);
  }

  return true;
}

/**
 * Get the verification record (for displaying expiry info in UI).
 * Accepts topic proofType — automatically maps to circuit-based cache key.
 */
export async function getVerificationCache(
  userId: string,
  proofType: string,
): Promise<VerificationRecord | null> {
  const ct = toCacheType(proofType);
  const data = await redis.get(cacheKey(userId, ct));
  if (!data) return null;
  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return null;
  return record;
}

/**
 * Get all active verifications for a user (for profile/badge display).
 */
export async function getActiveVerificationsCache(
  userId: string,
): Promise<{ proofType: string; record: VerificationRecord }[]> {
  const cacheTypes = ['kyc', 'country', 'oidc_domain', 'oidc_login'];
  const results: { proofType: string; record: VerificationRecord }[] = [];

  const keys = cacheTypes.map(ct => cacheKey(userId, ct));
  const values = await redis.mget(...keys);

  for (let i = 0; i < cacheTypes.length; i++) {
    if (values[i]) {
      const record: VerificationRecord = JSON.parse(values[i]!);
      if (record.expiresAt > Date.now()) {
        results.push({ proofType: cacheTypes[i], record });
      }
    }
  }

  return results;
}

/**
 * Badge info derived from verification cache.
 */
export interface Badge {
  type: string;
  label: string;
}

function cacheTypeToBadges(cacheType: string): Badge[] {
  switch (cacheType) {
    case 'kyc': return [{ type: 'kyc', label: 'KYC Verified' }];
    case 'country': return [{ type: 'country', label: 'Country Verified' }];
    case 'oidc_domain': return [{ type: 'workspace', label: 'Org Verified' }];
    case 'oidc_login': return [{ type: 'oidc', label: 'OIDC Verified' }];
    default: return [];
  }
}

/**
 * Get badges for a single user from Redis cache.
 */
export async function getUserBadges(userId: string): Promise<Badge[]> {
  const verifications = await getActiveVerificationsCache(userId);
  return verifications.flatMap(v => cacheTypeToBadges(v.proofType));
}

/**
 * Batch get badges for multiple users (for post/comment badge display).
 * Uses Redis MGET for efficiency.
 */
export async function getBatchUserBadges(
  userIds: string[],
): Promise<Map<string, Badge[]>> {
  const result = new Map<string, Badge[]>();
  if (userIds.length === 0) return result;

  const unique = [...new Set(userIds)];
  const cacheTypes = ['kyc', 'country', 'oidc_domain', 'oidc_login'];

  // Build all keys: userId × cacheType
  const keys: string[] = [];
  for (const uid of unique) {
    for (const ct of cacheTypes) {
      keys.push(cacheKey(uid, ct));
    }
  }

  const values = await redis.mget(...keys);
  const now = Date.now();

  for (let i = 0; i < unique.length; i++) {
    const uid = unique[i];
    const badges: Badge[] = [];
    for (let j = 0; j < cacheTypes.length; j++) {
      const val = values[i * cacheTypes.length + j];
      if (val) {
        const record: VerificationRecord = JSON.parse(val);
        if (record.expiresAt > now) {
          badges.push(...cacheTypeToBadges(cacheTypes[j]));
        }
      }
    }
    result.set(uid, badges);
  }

  return result;
}
