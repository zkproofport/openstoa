import { beforeEach, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/redis', () => ({ redis: {
  get: async (key: string) => values.get(key) ?? null,
  mget: async (...keys: string[]) => keys.map(key => values.get(key) ?? null),
  set: async (key: string, value: string, ...options: unknown[]) => {
    if (options.includes('NX') && values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  },
} }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

import { BADGE_TYPES, saveVerificationCache, setBadgeVisibility, getUserBadges, hasValidVerificationCache } from '@/lib/verification-cache';
import { withPublicIdentityBadges } from '@/lib/identity-badges';

beforeEach(async () => {
  values.clear();
  for (const type of BADGE_TYPES) {
    await saveVerificationCache('alice', type, type === 'oidc_domain' ? { domain: 'example.com' } : undefined);
  }
});

it.each([
  ['kyc', ['country', 'workspace', 'oidc']],
  ['country', ['kyc', 'workspace', 'oidc']],
  ['oidc_domain', ['kyc', 'country', 'oidc']],
  ['oidc_login', ['kyc', 'country', 'workspace']],
] as const)('turning OFF %s leaves every other badge public in any topic', async (type, remaining) => {
  await setBadgeVisibility('alice', type, false);
  const identities = await withPublicIdentityBadges([
    { userId: 'alice', proofType: 'none' },
    { userId: 'alice', proofType: 'kyc' },
    { userId: 'alice', proofType: 'workspace' },
  ], row => row.userId);
  for (const identity of identities) expect(identity.badges.map(b => b.type)).toEqual(remaining);
  expect(await hasValidVerificationCache('alice', type)).toBe(true);

  // Verification refresh must not reset this one switch or alter the others.
  await saveVerificationCache('alice', type, type === 'oidc_domain' ? { domain: 'example.com' } : undefined);
  expect((await getUserBadges('alice')).map(b => b.type)).toEqual(remaining);
  await setBadgeVisibility('alice', type, true);
  expect((await getUserBadges('alice')).map(b => b.type)).toEqual(['kyc', 'country', 'workspace', 'oidc']);
});

it('all badges can be hidden independently and login alone can be re-enabled publicly', async () => {
  for (const type of BADGE_TYPES) await setBadgeVisibility('alice', type, false);
  expect(await getUserBadges('alice')).toEqual([]);
  await setBadgeVisibility('alice', 'oidc_login', true);
  const [identity] = await withPublicIdentityBadges([{ userId: 'alice', proofType: 'none' }], row => row.userId);
  expect(identity.badges).toEqual([{ type: 'oidc', label: 'OIDC' }]);
});
