/**
 * Redis-based verification cache.
 *
 * Privacy-first design: NO personal information (domain, country, email) is stored in the database.
 * Verification status is cached in Redis with a 30-day TTL.
 * Country values are hashed; the verified workspace domain remains in Redis for badge display.
 * Visibility preferences contain only booleans and persist independently of verification TTL.
 *
 * Cache keys use CIRCUIT names (not topic proofType) because:
 * - google_workspace, microsoft_365, workspace all use the same circuit (oidc_domain_attestation)
 * - Topic authorization additionally checks the verified provider and domain
 * - Login records never carry topic-bound provenance
 *
 * When the cache expires, the user must re-verify to join new gated topics.
 * Existing topic memberships (topicMembers table) are NOT affected by cache expiry.
 */

import crypto from 'crypto';
import { redis } from './redis';

const VERIFICATION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

const KEY_PREFIX = 'community:verification:v2';
export const BADGE_TYPES = ['kyc', 'country', 'oidc_domain', 'oidc_login'] as const;
export type BadgeType = typeof BADGE_TYPES[number];

function visibilityKey(userId: string, type: string): string {
  return `community:badge-visibility:${userId}:${type}`;
}

export function isBadgeType(type: unknown): type is BadgeType {
  return typeof type === 'string' && (BADGE_TYPES as readonly string[]).includes(type);
}

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
  topicScope?: string;
  countryPredicate?: string;
  provider?: number;
  domainHash?: string;
  countryHash?: string;
  domain?: string; // plaintext domain — stored in Redis only (30-day TTL), used for domain badge display
  shownDomains?: string[]; // legacy visibility setting; an explicit empty array means OFF
}

/**
 * Save verification result to Redis cache.
 * Verification expires after 30 days; boolean badge preferences do not expire.
 */
export async function saveVerificationCache(
  userId: string,
  cacheType: string,
  options?: { domain?: string; country?: string; topicScope?: string; countryPredicate?: string; provider?: number },
): Promise<void> {
  // Move a legacy OFF choice before replacing its expiring record. NX protects a
  // newer explicit preference from concurrent verification/display requests.
  if (cacheType === 'oidc_domain') {
    const previous = await redis.get(cacheKey(userId, cacheType))
      ?? await redis.get(`community:verification:${userId}:${cacheType}`);
    if (previous) await preserveLegacyVisibility(userId, JSON.parse(previous));
  }
  const now = Date.now();
  const record: VerificationRecord = {
    topicScope: options?.topicScope,
    countryPredicate: options?.countryPredicate,
    provider: options?.provider,
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
  domain?: string; // verified domain — only present for visible workspace badges
}

/**
 * Convert cache type + verified domains to badge(s).
 * Public reads supply only the currently verified workspace domain.
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

/** Preserve legacy explicit OFF without retaining domain data beyond its TTL. */
async function preserveLegacyVisibility(userId: string, record: VerificationRecord): Promise<void> {
  if (Array.isArray(record.shownDomains) && record.shownDomains.length === 0) {
    await redis.set(visibilityKey(userId, 'oidc_domain'), 'false', 'NX');
  }
}

function verifiedDomain(record: VerificationRecord): string | undefined {
  const domain = record.domain?.toLowerCase().trim();
  if (!domain || (record.domainHash && hashValue(domain) !== record.domainHash)) return undefined;
  return domain;
}

export interface ProfileBadge {
  type: BadgeType;
  verifiedAt: number;
  expiresAt: number;
  visible: boolean;
  domain?: string;
}

/** One shared read path for owner controls and single/batch public display. */
async function loadProfileBadges(userIds: string[]): Promise<Map<string, ProfileBadge[]>> {
  const result = new Map<string, ProfileBadge[]>();
  const unique = [...new Set(userIds)].filter(uid => uid && !uid.startsWith('withdrawn:'));
  if (unique.length === 0) return result;
  const keys = unique.flatMap(uid => [
    ...BADGE_TYPES.map(type => cacheKey(uid, type)),
    ...BADGE_TYPES.map(type => visibilityKey(uid, type)),
  ]);
  const values = await redis.mget(...keys);
  const now = Date.now();
  const migrations: Promise<void>[] = [];
  unique.forEach((uid, i) => {
    const badges: ProfileBadge[] = [];
    BADGE_TYPES.forEach((type, j) => {
      const data = values[i * 8 + j];
      if (!data) return;
      const record: VerificationRecord = JSON.parse(data);
      const preference = values[i * 8 + 4 + j];
      const legacyHidden = type === 'oidc_domain' && Array.isArray(record.shownDomains) && record.shownDomains.length === 0;
      if (legacyHidden && preference == null) migrations.push(preserveLegacyVisibility(uid, record));
      if (record.expiresAt <= now) return;
      const domain = type === 'oidc_domain' ? verifiedDomain(record) : undefined;
      badges.push({ type, verifiedAt: record.verifiedAt, expiresAt: record.expiresAt,
        visible: preference == null ? !legacyHidden : preference === 'true',
        ...(domain ? {domain} : {}),
      });
    });
    result.set(uid, badges);
  });
  await Promise.all(migrations);
  return result;
}

export async function getProfileBadges(userId: string): Promise<ProfileBadge[]> {
  return (await loadProfileBadges([userId])).get(userId) ?? [];
}

/** Return false when no active verification exists; visibility never grants proof eligibility. */
export async function setBadgeVisibility(userId: string, type: BadgeType, visible: boolean): Promise<boolean> {
  if (!isBadgeType(type) || typeof visible !== 'boolean') return false;
  if (!await getVerificationCache(userId, type)) return false;
  await redis.set(visibilityKey(userId, type), JSON.stringify(visible));
  return true;
}

/** Compatibility wrapper: only the currently verified domain can be shown/hidden. */
export async function setDomainShown(userId: string, domain: string, shown: boolean): Promise<void> {
  const available = await getAvailableDomain(userId);
  if (!available || available !== domain.toLowerCase().trim()) return;
  await setBadgeVisibility(userId, 'oidc_domain', shown);
}

export async function clearShownDomains(userId: string): Promise<void> {
  await setBadgeVisibility(userId, 'oidc_domain', false);
}

export async function getShownDomains(userId: string): Promise<string[]> {
  const badge = (await getProfileBadges(userId)).find(b => b.type === 'oidc_domain');
  return badge?.visible && badge.domain ? [badge.domain] : [];
}

export async function getAvailableDomain(userId: string): Promise<string | null> {
  const record = await getVerificationCache(userId, 'oidc_domain');
  return record ? verifiedDomain(record) ?? null : null;
}

function publicBadges(badges: ProfileBadge[]): Badge[] {
  return badges.filter(b => b.visible).flatMap(b => cacheTypeToBadges(b.type, b.domain ? [b.domain] : undefined));
}

export async function getUserBadges(userId: string): Promise<Badge[]> {
  return publicBadges(await getProfileBadges(userId));
}

/** Batch public badges with the same visibility and expiry rules as single-user reads. */
export async function getBatchUserBadges(userIds: string[]): Promise<Map<string, Badge[]>> {
  const profiles = await loadProfileBadges(userIds);
  return new Map([...profiles].map(([uid, badges]) => [uid, publicBadges(badges)]));
}
