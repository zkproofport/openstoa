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
  domain?: string; // plaintext domain — stored in Redis only (30-day TTL), used for domain badge opt-in
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
    record.domain = options.domain.toLowerCase().trim();
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
  domain?: string; // plaintext domain — only present when user opted in to domain badge
}

/**
 * Convert cache type + opted-in domains to badge(s).
 * For oidc_domain with multiple domains, returns one badge per domain.
 */
function cacheTypeToBadges(cacheType: string, domains?: string[]): Badge[] {
  switch (cacheType) {
    case 'kyc': return [{ type: 'kyc', label: 'KYC Verified' }];
    case 'country': return [{ type: 'country', label: 'Country Verified' }];
    case 'oidc_domain':
      if (domains && domains.length > 0) {
        return domains.map(d => ({ type: 'workspace', label: d, domain: d }));
      }
      return [{ type: 'workspace', label: 'Org Verified' }];
    case 'oidc_login': return [{ type: 'oidc', label: 'OIDC Verified' }];
    default: return [];
  }
}

// --- Domain badge opt-in/out (multi-domain via Redis SET) ---

const DOMAIN_BADGE_PREFIX = 'community:domain-badge';

function domainBadgeKey(userId: string): string {
  return `${DOMAIN_BADGE_PREFIX}:${userId}`;
}

/**
 * Opt-in: add a domain to the user's public badge set.
 * Uses Redis SET (SADD) — multiple domains supported.
 */
export async function saveDomainBadge(userId: string, domain: string): Promise<void> {
  const key = domainBadgeKey(userId);
  await redis.sadd(key, domain.toLowerCase().trim());
  await redis.expire(key, VERIFICATION_TTL);
}

/**
 * Opt-out: remove a specific domain, or all domains if no domain specified.
 */
export async function deleteDomainBadge(userId: string, domain?: string): Promise<void> {
  if (domain) {
    await redis.srem(domainBadgeKey(userId), domain.toLowerCase().trim());
  } else {
    await redis.del(domainBadgeKey(userId));
  }
}

/**
 * Get all opted-in domains for a single user (empty array if none).
 */
export async function getDomainBadges(userId: string): Promise<string[]> {
  return redis.smembers(domainBadgeKey(userId));
}

/**
 * Batch get domain badges for multiple users via Redis pipeline.
 */
async function getBatchDomainBadges(userIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;

  const pipeline = redis.pipeline();
  for (const uid of userIds) {
    pipeline.smembers(domainBadgeKey(uid));
  }
  const responses = await pipeline.exec();
  if (!responses) return result;

  for (let i = 0; i < userIds.length; i++) {
    const [err, domains] = responses[i];
    if (!err && Array.isArray(domains) && domains.length > 0) {
      result.set(userIds[i], domains as string[]);
    }
  }
  return result;
}

/**
 * Get the plaintext domain from the oidc_domain verification record (for opt-in flow).
 * Returns null if no valid verification or domain not stored.
 */
export async function getVerifiedDomain(userId: string): Promise<string | null> {
  const data = await redis.get(cacheKey(userId, 'oidc_domain'));
  if (!data) return null;
  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return null;
  return record.domain ?? null;
}

/**
 * Get badges for a single user from Redis cache.
 */
export async function getUserBadges(userId: string): Promise<Badge[]> {
  const [verifications, domains] = await Promise.all([
    getActiveVerificationsCache(userId),
    getDomainBadges(userId),
  ]);
  return verifications.flatMap(v => {
    const d = (v.proofType === 'oidc_domain' && domains.length > 0) ? domains : undefined;
    return cacheTypeToBadges(v.proofType, d);
  });
}

/**
 * Batch get badges for multiple users (for post/comment badge display).
 * Uses Redis MGET + pipeline for efficiency.
 */
export async function getBatchUserBadges(
  userIds: string[],
): Promise<Map<string, Badge[]>> {
  const result = new Map<string, Badge[]>();
  if (userIds.length === 0) return result;

  const unique = [...new Set(userIds)];
  const cacheTypes = ['kyc', 'country', 'oidc_domain', 'oidc_login'];

  // Build all keys: userId × cacheType
  const verificationKeys: string[] = [];
  for (const uid of unique) {
    for (const ct of cacheTypes) {
      verificationKeys.push(cacheKey(uid, ct));
    }
  }

  // Fetch verification records and domain badges in parallel
  const [verificationValues, domainBadges] = await Promise.all([
    redis.mget(...verificationKeys),
    getBatchDomainBadges(unique),
  ]);
  const now = Date.now();

  for (let i = 0; i < unique.length; i++) {
    const uid = unique[i];
    const badges: Badge[] = [];
    for (let j = 0; j < cacheTypes.length; j++) {
      const val = verificationValues[i * cacheTypes.length + j];
      if (val) {
        const record: VerificationRecord = JSON.parse(val);
        if (record.expiresAt > now) {
          const domains = (cacheTypes[j] === 'oidc_domain' && domainBadges.has(uid))
            ? domainBadges.get(uid) : undefined;
          badges.push(...cacheTypeToBadges(cacheTypes[j], domains));
        }
      }
    }
    result.set(uid, badges);
  }

  return result;
}
