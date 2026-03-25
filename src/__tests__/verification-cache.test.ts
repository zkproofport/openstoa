import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  mget: vi.fn().mockResolvedValue([]),
  ttl: vi.fn().mockResolvedValue(86400),
  hset: vi.fn(),
  hdel: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({ redis: mockRedis }));

import {
  toCacheType,
  circuitToCacheType,
  circuitToCacheTypeForLogin,
  hasValidVerificationCache,
  saveVerificationCache,
  getVerificationCache,
  filterBadgesByTopicProofType,
} from '@/lib/verification-cache';

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

describe('toCacheType', () => {
  it('maps google_workspace to oidc_domain', () => {
    expect(toCacheType('google_workspace')).toBe('oidc_domain');
  });

  it('maps microsoft_365 to oidc_domain', () => {
    expect(toCacheType('microsoft_365')).toBe('oidc_domain');
  });

  it('maps workspace to oidc_domain', () => {
    expect(toCacheType('workspace')).toBe('oidc_domain');
  });

  it('passes through kyc unchanged', () => {
    expect(toCacheType('kyc')).toBe('kyc');
  });

  it('passes through country unchanged', () => {
    expect(toCacheType('country')).toBe('country');
  });

  it('passes through unknown strings unchanged', () => {
    expect(toCacheType('some_unknown_type')).toBe('some_unknown_type');
  });
});

describe('circuitToCacheType', () => {
  it('maps oidc_domain_attestation to oidc_domain', () => {
    expect(circuitToCacheType('oidc_domain_attestation')).toBe('oidc_domain');
  });

  it('maps coinbase_country_attestation to country', () => {
    expect(circuitToCacheType('coinbase_country_attestation')).toBe('country');
  });

  it('maps coinbase_attestation to kyc', () => {
    expect(circuitToCacheType('coinbase_attestation')).toBe('kyc');
  });

  it('passes through unknown circuit names unchanged', () => {
    expect(circuitToCacheType('some_new_circuit')).toBe('some_new_circuit');
  });
});

describe('circuitToCacheTypeForLogin', () => {
  it('maps oidc_domain_attestation to oidc_login (not oidc_domain)', () => {
    expect(circuitToCacheTypeForLogin('oidc_domain_attestation')).toBe('oidc_login');
  });

  it('differs from circuitToCacheType for oidc_domain_attestation', () => {
    expect(circuitToCacheTypeForLogin('oidc_domain_attestation')).not.toBe(
      circuitToCacheType('oidc_domain_attestation'),
    );
  });

  it('maps coinbase_country_attestation to country', () => {
    expect(circuitToCacheTypeForLogin('coinbase_country_attestation')).toBe('country');
  });

  it('maps coinbase_attestation to kyc', () => {
    expect(circuitToCacheTypeForLogin('coinbase_attestation')).toBe('kyc');
  });

  it('passes through unknown circuit names unchanged', () => {
    expect(circuitToCacheTypeForLogin('some_new_circuit')).toBe('some_new_circuit');
  });
});

describe('hasValidVerificationCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no cache record exists', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const result = await hasValidVerificationCache('user1', 'kyc');

    expect(result).toBe(false);
  });

  it('returns true when valid cache record exists', async () => {
    const record = {
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'kyc');

    expect(result).toBe(true);
  });

  it('returns false when cache record is expired', async () => {
    const record = {
      verifiedAt: Date.now() - 86400000,
      expiresAt: Date.now() - 1000,
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'kyc');

    expect(result).toBe(false);
  });

  it('returns true when domain matches stored hash', async () => {
    const domain = 'company.com';
    const record = {
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      domainHash: hashValue(domain),
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'google_workspace', domain);

    expect(result).toBe(true);
  });

  it('returns false when domain does not match stored hash', async () => {
    const record = {
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      domainHash: hashValue('other-company.com'),
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'google_workspace', 'company.com');

    expect(result).toBe(false);
  });

  it('returns false when required domain is provided but record has no domainHash', async () => {
    const record = {
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'google_workspace', 'company.com');

    expect(result).toBe(false);
  });

  it('uses toCacheType to resolve the redis key (workspace maps to oidc_domain)', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    await hasValidVerificationCache('user1', 'workspace');

    expect(mockRedis.get).toHaveBeenCalledWith('community:verification:user1:oidc_domain');
  });

  it('domain hash match is case-insensitive and trims whitespace', async () => {
    const domain = 'company.com';
    const record = {
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      domainHash: hashValue(domain),
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await hasValidVerificationCache('user1', 'google_workspace', '  COMPANY.COM  ');

    expect(result).toBe(true);
  });
});

describe('saveVerificationCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves record with correct cache key', async () => {
    await saveVerificationCache('user1', 'kyc');

    const [key] = mockRedis.set.mock.calls[0];
    expect(key).toBe('community:verification:user1:kyc');
  });

  it('saves record with 30-day TTL', async () => {
    await saveVerificationCache('user1', 'kyc');

    const [, , ex, ttl] = mockRedis.set.mock.calls[0];
    expect(ex).toBe('EX');
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });

  it('saves verifiedAt and expiresAt timestamps', async () => {
    const before = Date.now();
    await saveVerificationCache('user1', 'kyc');
    const after = Date.now();

    const [, json] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(json);

    expect(record.verifiedAt).toBeGreaterThanOrEqual(before);
    expect(record.verifiedAt).toBeLessThanOrEqual(after);
    expect(record.expiresAt).toBeGreaterThan(record.verifiedAt);
  });

  it('stores hashed domain and plaintext domain when domain option is provided', async () => {
    await saveVerificationCache('user1', 'oidc_domain', { domain: 'company.com' });

    const [, json] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(json);

    expect(record.domainHash).toBe(hashValue('company.com'));
    expect(record.domain).toBe('company.com');
  });

  it('normalizes domain to lowercase and trimmed when storing', async () => {
    await saveVerificationCache('user1', 'oidc_domain', { domain: '  Company.COM  ' });

    const [, json] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(json);

    expect(record.domain).toBe('company.com');
    expect(record.domainHash).toBe(hashValue('company.com'));
  });

  it('stores hashed country when country option is provided', async () => {
    await saveVerificationCache('user1', 'country', { country: 'US' });

    const [, json] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(json);

    expect(record.countryHash).toBe(hashValue('US'));
    expect(record.country).toBeUndefined();
  });

  it('stores no domain fields when no options provided', async () => {
    await saveVerificationCache('user1', 'kyc');

    const [, json] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(json);

    expect(record.domainHash).toBeUndefined();
    expect(record.domain).toBeUndefined();
    expect(record.countryHash).toBeUndefined();
  });
});

describe('getVerificationCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no record exists', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const result = await getVerificationCache('user1', 'kyc');

    expect(result).toBeNull();
  });

  it('returns the record when valid', async () => {
    const now = Date.now();
    const record = {
      verifiedAt: now,
      expiresAt: now + 86400000,
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await getVerificationCache('user1', 'kyc');

    expect(result).not.toBeNull();
    expect(result!.verifiedAt).toBe(record.verifiedAt);
    expect(result!.expiresAt).toBe(record.expiresAt);
  });

  it('returns null when record is expired', async () => {
    const record = {
      verifiedAt: Date.now() - 86400000,
      expiresAt: Date.now() - 1000,
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await getVerificationCache('user1', 'kyc');

    expect(result).toBeNull();
  });

  it('uses toCacheType to resolve the redis key', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    await getVerificationCache('user1', 'google_workspace');

    expect(mockRedis.get).toHaveBeenCalledWith('community:verification:user1:oidc_domain');
  });

  it('returns record with domainHash when present', async () => {
    const now = Date.now();
    const record = {
      verifiedAt: now,
      expiresAt: now + 86400000,
      domainHash: hashValue('company.com'),
      domain: 'company.com',
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

    const result = await getVerificationCache('user1', 'workspace');

    expect(result!.domainHash).toBe(hashValue('company.com'));
    expect(result!.domain).toBe('company.com');
  });
});

describe('filterBadgesByTopicProofType', () => {
  const allBadges = [
    { type: 'kyc', label: 'KYC' },
    { type: 'country', label: 'Country' },
    { type: 'workspace', label: 'company.com', domain: 'company.com' },
    { type: 'workspace', label: 'Org' },
    { type: 'oidc', label: 'OIDC' },
  ];

  it('returns empty array for null proofType', () => {
    expect(filterBadgesByTopicProofType(allBadges, null)).toEqual([]);
  });

  it('returns empty array for "none" proofType', () => {
    expect(filterBadgesByTopicProofType(allBadges, 'none')).toEqual([]);
  });

  it('returns only kyc badges for kyc proofType', () => {
    const result = filterBadgesByTopicProofType(allBadges, 'kyc');
    expect(result).toEqual([{ type: 'kyc', label: 'KYC' }]);
  });

  it('returns only country badges for country proofType', () => {
    const result = filterBadgesByTopicProofType(allBadges, 'country');
    expect(result).toEqual([{ type: 'country', label: 'Country' }]);
  });

  it('returns only workspace badges with domain for workspace proofType', () => {
    const result = filterBadgesByTopicProofType(allBadges, 'workspace');
    expect(result).toEqual([{ type: 'workspace', label: 'company.com', domain: 'company.com' }]);
    expect(result.every(b => b.domain)).toBe(true);
  });

  it('excludes generic Org badge (no domain) for workspace proofType', () => {
    const genericOnly = [{ type: 'workspace', label: 'Org' }];
    const result = filterBadgesByTopicProofType(genericOnly, 'workspace');
    expect(result).toEqual([]);
  });

  it('returns only workspace badges with domain for google_workspace proofType', () => {
    const result = filterBadgesByTopicProofType(allBadges, 'google_workspace');
    expect(result).toEqual([{ type: 'workspace', label: 'company.com', domain: 'company.com' }]);
  });

  it('returns only workspace badges with domain for microsoft_365 proofType', () => {
    const result = filterBadgesByTopicProofType(allBadges, 'microsoft_365');
    expect(result).toEqual([{ type: 'workspace', label: 'company.com', domain: 'company.com' }]);
  });

  it('returns empty array for unknown proofType', () => {
    expect(filterBadgesByTopicProofType(allBadges, 'unknown_type')).toEqual([]);
  });

  it('returns empty array when badge list is empty', () => {
    expect(filterBadgesByTopicProofType([], 'kyc')).toEqual([]);
  });
});
