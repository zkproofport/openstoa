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
  shownDomains?: string[]; // domains opted-in for public badge display — lives inside oidc_domain record
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
    case 'kyc': return [{ type: 'kyc', label: 'KYC' }];
    case 'country': return [{ type: 'country', label: 'Country' }];
    case 'oidc_domain':
      if (domains && domains.length > 0) {
        return domains.map(d => ({ type: 'workspace', label: d, domain: d }));
      }
      return [{ type: 'workspace', label: 'Org' }];
    case 'oidc_login': return [{ type: 'oidc', label: 'OIDC' }];
    default: return [];
  }
}

// --- Domain badge opt-in/out (merged into oidc_domain record) ---

/**
 * Toggle domain visibility in the user's oidc_domain verification record.
 * Reads the record, adds/removes the domain from shownDomains, writes back with remaining TTL.
 */
export async function setDomainShown(userId: string, domain: string, shown: boolean): Promise<void> {
  const key = cacheKey(userId, 'oidc_domain');
  const data = await redis.get(key);
  if (!data) return;

  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return;

  const normalized = domain.toLowerCase().trim();
  const current = record.shownDomains ?? [];

  if (shown) {
    if (!current.includes(normalized)) {
      record.shownDomains = [...current, normalized];
    } else {
      return; // already shown, no-op
    }
  } else {
    if (domain) {
      record.shownDomains = current.filter(d => d !== normalized);
    } else {
      record.shownDomains = [];
    }
  }

  // Preserve remaining TTL
  const remainingTtl = await redis.ttl(key);
  if (remainingTtl <= 0) return;

  await redis.set(key, JSON.stringify(record), 'EX', remainingTtl);
}

/**
 * Clear all shown domains from the oidc_domain record.
 */
export async function clearShownDomains(userId: string): Promise<void> {
  const key = cacheKey(userId, 'oidc_domain');
  const data = await redis.get(key);
  if (!data) return;

  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return;

  record.shownDomains = [];

  const remainingTtl = await redis.ttl(key);
  if (remainingTtl <= 0) return;

  await redis.set(key, JSON.stringify(record), 'EX', remainingTtl);
}

/**
 * Get all opted-in (shown) domains for a user from the oidc_domain record.
 */
export async function getShownDomains(userId: string): Promise<string[]> {
  const data = await redis.get(cacheKey(userId, 'oidc_domain'));
  if (!data) return [];
  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return [];
  return record.shownDomains ?? [];
}

/**
 * Get the plaintext domain from the oidc_domain verification record (for opt-in flow).
 * Returns null if no valid verification or domain not stored.
 */
export async function getAvailableDomain(userId: string): Promise<string | null> {
  const data = await redis.get(cacheKey(userId, 'oidc_domain'));
  if (!data) return null;
  const record: VerificationRecord = JSON.parse(data);
  if (record.expiresAt <= Date.now()) return null;
  return record.domain ?? null;
}

/**
 * Get badges for a single user from Redis cache.
 * shownDomains is read from the oidc_domain record directly — no extra Redis query.
 */
export async function getUserBadges(userId: string): Promise<Badge[]> {
  const verifications = await getActiveVerificationsCache(userId);
  return verifications.flatMap(v => {
    if (v.proofType === 'oidc_domain') {
      const shown = v.record.shownDomains ?? [];
      return cacheTypeToBadges(v.proofType, shown.length > 0 ? shown : undefined);
    }
    return cacheTypeToBadges(v.proofType);
  });
}

/**
 * Filter badges by the topic's proofType.
 * - 'none' (open topic) → no badges
 * - 'kyc' → only KYC badges
 * - 'country' → only Country badges
 * - 'google_workspace'/'microsoft_365'/'workspace' → only opt-in domain badges (with domain field)
 *   Generic "Org Verified" is excluded — only domain badges where user opted in are shown.
 */
export function filterBadgesByTopicProofType(badges: Badge[], topicProofType: string | null): Badge[] {
  if (!topicProofType || topicProofType === 'none') return [];

  switch (topicProofType) {
    case 'kyc':
      return badges.filter(b => b.type === 'kyc');
    case 'country':
      return badges.filter(b => b.type === 'country');
    case 'google_workspace':
    case 'microsoft_365':
    case 'workspace':
      // Only opt-in domain badges (with actual domain value), not generic "Org Verified"
      return badges.filter(b => (b.type === 'workspace' || b.type === 'oidc_domain') && b.domain);
    default:
      return [];
  }
}

/**
 * Batch get badges for multiple users (for post/comment badge display).
 * Uses a single Redis MGET call — shownDomains is read from the oidc_domain record directly.
 * No extra Redis queries needed (no separate domain badge key).
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

  // Single MGET call — no separate domain badge query needed
  const verificationValues = await redis.mget(...verificationKeys);
  const now = Date.now();

  for (let i = 0; i < unique.length; i++) {
    const uid = unique[i];
    const badges: Badge[] = [];
    for (let j = 0; j < cacheTypes.length; j++) {
      const val = verificationValues[i * cacheTypes.length + j];
      if (val) {
        const record: VerificationRecord = JSON.parse(val);
        if (record.expiresAt > now) {
          if (cacheTypes[j] === 'oidc_domain') {
            const shown = record.shownDomains ?? [];
            badges.push(...cacheTypeToBadges(cacheTypes[j], shown.length > 0 ? shown : undefined));
          } else {
            badges.push(...cacheTypeToBadges(cacheTypes[j]));
          }
        }
      }
    }
    result.set(uid, badges);
  }

  return result;
}
