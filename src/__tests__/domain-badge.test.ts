import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = vi.hoisted(() => ({
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
  mget: vi.fn().mockResolvedValue([]),
  ttl: vi.fn().mockResolvedValue(2500000),
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

import {
  setDomainShown,
  clearShownDomains,
  getShownDomains,
  getAvailableDomain,
  getUserBadges,
  getBatchUserBadges,
  saveVerificationCache,
} from '@/lib/verification-cache';

describe('Domain Badge — merged into oidc_domain record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.ttl.mockResolvedValue(2500000);
  });

  describe('setDomainShown', () => {
    it('should add domain to shownDomains in oidc_domain record', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await setDomainShown('user1', 'company.com', true);

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, json, ex, ttl] = mockRedis.set.mock.calls[0];
      expect(key).toBe('community:verification:user1:oidc_domain');
      expect(ex).toBe('EX');
      expect(ttl).toBe(2500000);
      const updated = JSON.parse(json);
      expect(updated.shownDomains).toEqual(['company.com']);
    });

    it('should not duplicate domain if already shown', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
        shownDomains: ['company.com'],
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await setDomainShown('user1', 'company.com', true);

      // Should not write back since it's a no-op
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should remove specific domain when shown=false', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
        shownDomains: ['company-a.com', 'company-b.com'],
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await setDomainShown('user1', 'company-a.com', false);

      const [, json] = mockRedis.set.mock.calls[0];
      const updated = JSON.parse(json);
      expect(updated.shownDomains).toEqual(['company-b.com']);
    });

    it('should lowercase and trim domain', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await setDomainShown('user1', '  Company.COM  ', true);

      const [, json] = mockRedis.set.mock.calls[0];
      const updated = JSON.parse(json);
      expect(updated.shownDomains).toEqual(['company.com']);
    });

    it('should no-op when no oidc_domain record exists', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await setDomainShown('user1', 'company.com', true);

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should no-op when record is expired', async () => {
      const record = {
        verifiedAt: Date.now() - 86400000,
        expiresAt: Date.now() - 1000,
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await setDomainShown('user1', 'company.com', true);

      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('clearShownDomains', () => {
    it('should set shownDomains to empty array', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
        shownDomains: ['company-a.com', 'company-b.com'],
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      await clearShownDomains('user1');

      const [, json] = mockRedis.set.mock.calls[0];
      const updated = JSON.parse(json);
      expect(updated.shownDomains).toEqual([]);
    });
  });

  describe('getShownDomains', () => {
    it('should return shownDomains from record', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
        shownDomains: ['a.com', 'b.com'],
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getShownDomains('user1');
      expect(result).toEqual(['a.com', 'b.com']);
    });

    it('should return empty array when no shownDomains', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getShownDomains('user1');
      expect(result).toEqual([]);
    });

    it('should return empty array when no record', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await getShownDomains('user1');
      expect(result).toEqual([]);
    });

    it('should return empty array when record expired', async () => {
      const record = {
        verifiedAt: Date.now() - 86400000,
        expiresAt: Date.now() - 1000,
        shownDomains: ['a.com'],
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getShownDomains('user1');
      expect(result).toEqual([]);
    });
  });

  describe('getAvailableDomain', () => {
    it('should return domain from verification record', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getAvailableDomain('user1');
      expect(result).toBe('company.com');
    });

    it('should return null for expired record', async () => {
      const record = {
        verifiedAt: Date.now() - 86400000,
        expiresAt: Date.now() - 1000,
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getAvailableDomain('user1');
      expect(result).toBeNull();
    });

    it('should return null when no record exists', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await getAvailableDomain('user1');
      expect(result).toBeNull();
    });

    it('should return null when record has no domain', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domainHash: 'abc',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getAvailableDomain('user1');
      expect(result).toBeNull();
    });
  });
});

describe('Domain Badge — Badge display integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserBadges', () => {
    it('should return workspace badge with domain when opted in (shownDomains in record)', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
        shownDomains: ['company.com'],
      });

      // getActiveVerificationsCache reads 4 keys via mget
      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);

      const badges = await getUserBadges('user1');

      expect(badges).toEqual([
        { type: 'workspace', label: 'company.com', domain: 'company.com' },
      ]);
    });

    it('should return generic workspace badge when not opted in (no shownDomains)', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      });

      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);

      const badges = await getUserBadges('user1');

      expect(badges).toEqual([
        { type: 'workspace', label: 'Org Verified' },
      ]);
    });

    it('should return multiple domain badges when multiple in shownDomains', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
        shownDomains: ['company-a.com', 'company-b.com'],
      });

      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);

      const badges = await getUserBadges('user1');

      expect(badges).toEqual([
        { type: 'workspace', label: 'company-a.com', domain: 'company-a.com' },
        { type: 'workspace', label: 'company-b.com', domain: 'company-b.com' },
      ]);
    });

    it('should combine KYC and domain badges', async () => {
      const now = Date.now();
      const kycRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
      });
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
        shownDomains: ['company.com'],
      });

      mockRedis.mget.mockResolvedValueOnce([kycRecord, null, oidcRecord, null]);

      const badges = await getUserBadges('user1');

      expect(badges).toHaveLength(2);
      expect(badges[0]).toEqual({ type: 'kyc', label: 'KYC Verified' });
      expect(badges[1]).toEqual({ type: 'workspace', label: 'company.com', domain: 'company.com' });
    });
  });

  describe('getBatchUserBadges', () => {
    it('should return empty map for empty input', async () => {
      const result = await getBatchUserBadges([]);
      expect(result.size).toBe(0);
    });

    it('should batch fetch badges for multiple users from single MGET', async () => {
      const now = Date.now();
      const kycRecord = JSON.stringify({ verifiedAt: now, expiresAt: now + 86400000 });
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domain: 'org.com',
        shownDomains: ['org.com'],
      });

      // user1: kyc only, user2: oidc_domain with shownDomains
      mockRedis.mget.mockResolvedValueOnce([
        kycRecord, null, null, null,  // user1
        null, null, oidcRecord, null, // user2
      ]);

      const result = await getBatchUserBadges(['user1', 'user2']);

      expect(result.get('user1')).toEqual([{ type: 'kyc', label: 'KYC Verified' }]);
      expect(result.get('user2')).toEqual([{ type: 'workspace', label: 'org.com', domain: 'org.com' }]);
    });

    it('should deduplicate user IDs', async () => {
      mockRedis.mget.mockResolvedValueOnce([null, null, null, null]);

      await getBatchUserBadges(['user1', 'user1', 'user1']);

      // Should only query once for user1 (4 cache types)
      expect(mockRedis.mget).toHaveBeenCalledTimes(1);
      const mgetArgs = mockRedis.mget.mock.calls[0];
      expect(mgetArgs).toHaveLength(4); // 1 unique user × 4 cache types
    });

    it('should show generic badge when oidc_domain has no shownDomains', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domain: 'org.com',
        // no shownDomains
      });

      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);

      const result = await getBatchUserBadges(['user1']);
      expect(result.get('user1')).toEqual([{ type: 'workspace', label: 'Org Verified' }]);
    });
  });
});

describe('saveVerificationCache — domain plaintext storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should store plaintext domain alongside hash', async () => {
    await saveVerificationCache('user1', 'oidc_domain', { domain: 'company.com' });

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [, recordJson] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(recordJson);

    expect(record.domainHash).toBeTruthy();
    expect(record.domain).toBe('company.com');
  });

  it('should not store domain when not provided', async () => {
    await saveVerificationCache('user1', 'kyc');

    const [, recordJson] = mockRedis.set.mock.calls[0];
    const record = JSON.parse(recordJson);

    expect(record.domainHash).toBeUndefined();
    expect(record.domain).toBeUndefined();
  });
});
