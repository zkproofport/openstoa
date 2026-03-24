import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = vi.hoisted(() => ({
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
  mget: vi.fn().mockResolvedValue([]),
  sadd: vi.fn().mockResolvedValue(1),
  srem: vi.fn().mockResolvedValue(1),
  smembers: vi.fn().mockResolvedValue([]),
  expire: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => ({
    smembers: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

import {
  saveDomainBadge,
  deleteDomainBadge,
  getDomainBadges,
  getVerifiedDomain,
  getUserBadges,
  getBatchUserBadges,
  saveVerificationCache,
} from '@/lib/verification-cache';

describe('Domain Badge — Redis SET operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveDomainBadge', () => {
    it('should SADD domain to set and set TTL', async () => {
      await saveDomainBadge('user1', 'company.com');

      expect(mockRedis.sadd).toHaveBeenCalledWith(
        'community:domain-badge:user1',
        'company.com',
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        'community:domain-badge:user1',
        30 * 24 * 60 * 60,
      );
    });

    it('should lowercase and trim domain', async () => {
      await saveDomainBadge('user1', '  Company.COM  ');

      expect(mockRedis.sadd).toHaveBeenCalledWith(
        'community:domain-badge:user1',
        'company.com',
      );
    });
  });

  describe('deleteDomainBadge', () => {
    it('should SREM specific domain when domain provided', async () => {
      await deleteDomainBadge('user1', 'company.com');

      expect(mockRedis.srem).toHaveBeenCalledWith(
        'community:domain-badge:user1',
        'company.com',
      );
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should DEL entire key when no domain provided', async () => {
      await deleteDomainBadge('user1');

      expect(mockRedis.del).toHaveBeenCalledWith('community:domain-badge:user1');
      expect(mockRedis.srem).not.toHaveBeenCalled();
    });
  });

  describe('getDomainBadges', () => {
    it('should return SMEMBERS result', async () => {
      mockRedis.smembers.mockResolvedValueOnce(['a.com', 'b.com']);

      const result = await getDomainBadges('user1');

      expect(mockRedis.smembers).toHaveBeenCalledWith('community:domain-badge:user1');
      expect(result).toEqual(['a.com', 'b.com']);
    });

    it('should return empty array when no domains', async () => {
      mockRedis.smembers.mockResolvedValueOnce([]);

      const result = await getDomainBadges('user1');
      expect(result).toEqual([]);
    });
  });

  describe('getVerifiedDomain', () => {
    it('should return domain from verification record', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getVerifiedDomain('user1');
      expect(result).toBe('company.com');
    });

    it('should return null for expired record', async () => {
      const record = {
        verifiedAt: Date.now() - 86400000,
        expiresAt: Date.now() - 1000,
        domain: 'company.com',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getVerifiedDomain('user1');
      expect(result).toBeNull();
    });

    it('should return null when no record exists', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await getVerifiedDomain('user1');
      expect(result).toBeNull();
    });

    it('should return null when record has no domain', async () => {
      const record = {
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        domainHash: 'abc',
      };
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(record));

      const result = await getVerifiedDomain('user1');
      expect(result).toBeNull();
    });
  });
});

describe('Domain Badge — Badge display integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserBadges', () => {
    it('should return workspace badge with domain when opted in', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      });

      // getActiveVerificationsCache reads 4 keys via mget
      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);
      // getDomainBadges reads the SET
      mockRedis.smembers.mockResolvedValueOnce(['company.com']);

      const badges = await getUserBadges('user1');

      expect(badges).toEqual([
        { type: 'workspace', label: 'company.com', domain: 'company.com' },
      ]);
    });

    it('should return generic workspace badge when not opted in', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      });

      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);
      mockRedis.smembers.mockResolvedValueOnce([]);

      const badges = await getUserBadges('user1');

      expect(badges).toEqual([
        { type: 'workspace', label: 'Org Verified' },
      ]);
    });

    it('should return multiple domain badges when multiple opted in', async () => {
      const now = Date.now();
      const oidcRecord = JSON.stringify({
        verifiedAt: now,
        expiresAt: now + 86400000,
        domainHash: 'abc',
        domain: 'company.com',
      });

      mockRedis.mget.mockResolvedValueOnce([null, null, oidcRecord, null]);
      mockRedis.smembers.mockResolvedValueOnce(['company-a.com', 'company-b.com']);

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
      });

      mockRedis.mget.mockResolvedValueOnce([kycRecord, null, oidcRecord, null]);
      mockRedis.smembers.mockResolvedValueOnce(['company.com']);

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

    it('should batch fetch badges for multiple users', async () => {
      const now = Date.now();
      const kycRecord = JSON.stringify({ verifiedAt: now, expiresAt: now + 86400000 });
      const oidcRecord = JSON.stringify({ verifiedAt: now, expiresAt: now + 86400000, domain: 'org.com' });

      // user1: kyc only, user2: oidc_domain only
      // mget for [user1:kyc, user1:country, user1:oidc_domain, user1:oidc_login, user2:kyc, ...]
      mockRedis.mget.mockResolvedValueOnce([
        kycRecord, null, null, null,  // user1
        null, null, oidcRecord, null, // user2
      ]);

      // pipeline.exec for domain badges
      const mockPipeline = {
        smembers: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, []],           // user1: no domain badges
          [null, ['org.com']],  // user2: opted in
        ]),
      };
      mockRedis.pipeline.mockReturnValueOnce(mockPipeline);

      const result = await getBatchUserBadges(['user1', 'user2']);

      expect(result.get('user1')).toEqual([{ type: 'kyc', label: 'KYC Verified' }]);
      expect(result.get('user2')).toEqual([{ type: 'workspace', label: 'org.com', domain: 'org.com' }]);
    });

    it('should deduplicate user IDs', async () => {
      mockRedis.mget.mockResolvedValueOnce([null, null, null, null]);

      const mockPipeline = {
        smembers: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, []]]),
      };
      mockRedis.pipeline.mockReturnValueOnce(mockPipeline);

      await getBatchUserBadges(['user1', 'user1', 'user1']);

      // Should only query once for user1 (4 cache types)
      expect(mockRedis.mget).toHaveBeenCalledTimes(1);
      const mgetArgs = mockRedis.mget.mock.calls[0];
      expect(mgetArgs).toHaveLength(4); // 1 unique user × 4 cache types
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
