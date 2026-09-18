import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
const { values, mockRedis } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, mockRedis: {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map(k => values.get(k) ?? null)),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value); return 'OK';
    }),
  } };
});
vi.mock('@/lib/redis', () => ({ redis: mockRedis }));
import { saveVerificationCache, setBadgeVisibility, getProfileBadges, setDomainShown,
  clearShownDomains, getShownDomains, getAvailableDomain, getUserBadges,
  getBatchUserBadges, hasValidVerificationCache,
} from '@/lib/verification-cache';
const recordKey = (type: string) => `community:verification:v2:user1:${type}`;
const types = ['kyc', 'country', 'oidc_domain', 'oidc_login'] as const;
function legacy(extra = {}) {
  values.set(recordKey('oidc_domain'), JSON.stringify({ verifiedAt: Date.now(),
    expiresAt: Date.now() + 86400000, domain: 'company.com',
    domainHash: crypto.createHash('sha256').update('company.com').digest('hex'), ...extra }));
}
beforeEach(() => { values.clear(); vi.clearAllMocks(); });
describe('Badge visibility preferences', () => {
  it('shows all newly verified badge types and the workspace domain by default', async () => {
    for (const type of types) await saveVerificationCache('user1', type, { domain: 'company.com' });
    expect(await getUserBadges('user1')).toEqual([
      {type:'kyc',label:'KYC'}, {type:'country',label:'Country'},
      {type:'workspace',label:'company.com',domain:'company.com'}, {type:'oidc',label:'OIDC'},
    ]);
    expect(await getShownDomains('user1')).toEqual(['company.com']);
    expect((await getProfileBadges('user1')).every(b => b.visible)).toBe(true);
  });
  it.each(types)('persists %s OFF through refresh, expiry and new verification without affecting eligibility', async type => {
    await saveVerificationCache('user1', type, {domain:'company.com'});
    expect(await setBadgeVisibility('user1', type, false)).toBe(true);
    expect(await hasValidVerificationCache('user1', type)).toBe(true);
    await saveVerificationCache('user1', type, {domain:'company.com'});
    expect(await getUserBadges('user1')).toEqual([]);
    values.delete(recordKey(type)); // Redis verification TTL elapsed
    expect(await getUserBadges('user1')).toEqual([]);
    await saveVerificationCache('user1', type, {domain:'new.com'});
    expect(await getUserBadges('user1')).toEqual([]);
    expect((await getProfileBadges('user1'))[0].visible).toBe(false);
    expect(await setBadgeVisibility('user1', type, true)).toBe(true);
    expect(await getUserBadges('user1')).toHaveLength(1);
    const preferences = mockRedis.set.mock.calls.filter(([key]) => !key.startsWith('community:verification:v2:'));
    expect(preferences.length).toBeGreaterThan(0);
    expect(preferences.every(call => !call.includes('EX'))).toBe(true);
  });
  it('keeps legacy explicit empty shownDomains hidden, including after refresh and expiry', async () => {
    legacy({shownDomains:[]});
    expect(await getShownDomains('user1')).toEqual([]);
    await saveVerificationCache('user1', 'oidc_domain', {domain:'company.com'});
    expect(await getUserBadges('user1')).toEqual([]);
    values.delete(recordKey('oidc_domain'));
    await saveVerificationCache('user1', 'oidc_domain', {domain:'company.com'});
    expect(await getUserBadges('user1')).toEqual([]);
  });
  it('migrates legacy OFF before re-verification even without an earlier display read', async () => {
    legacy({shownDomains:[]});
    await saveVerificationCache('user1','oidc_domain',{domain:'new.com'});
    expect(await getShownDomains('user1')).toEqual([]);
  });
  it('never displays domains from an unverified legacy shownDomains list', async () => {
    legacy({shownDomains:['company.com','unverified.com']});
    expect(await getShownDomains('user1')).toEqual(['company.com']);
    expect(await getUserBadges('user1')).toEqual([{type:'workspace',label:'company.com',domain:'company.com'}]);
    await setDomainShown('user1','unverified.com',true);
    expect(await getShownDomains('user1')).toEqual(['company.com']);
  });
  it('does not expose plaintext domains that disagree with the verified hash', async () => {
    legacy({domain:'unverified.com'});
    expect(await getAvailableDomain('user1')).toBeNull();
    expect(await getShownDomains('user1')).toEqual([]);
    expect((await getProfileBadges('user1'))[0].domain).toBeUndefined();
  });
  it('honors an explicit ON over a legacy OFF record without changing verification expiry', async () => {
    legacy({shownDomains:[]});
    const original = values.get(recordKey('oidc_domain'));
    await setBadgeVisibility('user1','oidc_domain',true);
    expect(await getShownDomains('user1')).toEqual(['company.com']);
    expect(values.get(recordKey('oidc_domain'))).toBe(original);
    await saveVerificationCache('user1','oidc_domain',{domain:'new.com'});
    expect(await getShownDomains('user1')).toEqual(['new.com']);
  });
  it('keeps old records without domain plaintext generic and does not reconstruct domain from shownDomains', async () => {
    legacy({domain:undefined,shownDomains:['unverified.com']});
    expect(await getAvailableDomain('user1')).toBeNull();
    expect(await getShownDomains('user1')).toEqual([]);
    expect(await getUserBadges('user1')).toEqual([{type:'workspace',label:'Org'}]);
  });
  it('never exposes an expired verification even with a visibility preference', async () => {
    legacy(); await setBadgeVisibility('user1','oidc_domain',true);
    legacy({expiresAt:Date.now()-1});
    expect(await getUserBadges('user1')).toEqual([]);
    expect(await getProfileBadges('user1')).toEqual([]);
    expect(await getShownDomains('user1')).toEqual([]);
    expect(await getAvailableDomain('user1')).toBeNull();
    expect(await setBadgeVisibility('user1','oidc_domain',true)).toBe(false);
  });
  it('keeps domain helpers and general preferences synchronized', async () => {
    legacy(); await clearShownDomains('user1');
    expect(await getUserBadges('user1')).toEqual([]);
    await setDomainShown('user1',' COMPANY.COM ',true);
    expect(await getShownDomains('user1')).toEqual(['company.com']);
    await setBadgeVisibility('user1','oidc_domain',false);
    expect(await getShownDomains('user1')).toEqual([]);
  });
  it('has single/batch parity with hidden, legacy, active and expired badges and deduplicates users', async () => {
    legacy({shownDomains:[]});
    await saveVerificationCache('user1','kyc');
    await saveVerificationCache('user2','country');
    await setBadgeVisibility('user2','country',false);
    await saveVerificationCache('user3','oidc_login');
    values.set('community:verification:v2:expired:kyc', JSON.stringify({verifiedAt:1,expiresAt:2}));
    const ids=['user1','user2','user3','expired','missing'];
    const single = await Promise.all(ids.map(getUserBadges));
    mockRedis.mget.mockClear();
    const batch=await getBatchUserBadges([...ids,'user1']);
    expect([...batch.values()]).toEqual(single);
    expect(mockRedis.mget).toHaveBeenCalledTimes(1);
    expect(await getBatchUserBadges([])).toEqual(new Map());
  });
});

it('preserves only legacy v1 OFF preference when creating a freshly verified v2 record',async()=>{
  values.set('community:verification:user1:oidc_domain',JSON.stringify({verifiedAt:1,expiresAt:Date.now()+10000,domain:'old.com',shownDomains:[]}));
  expect(await getUserBadges('user1')).toEqual([]);
  expect(await hasValidVerificationCache('user1','workspace')).toBe(false);
  await saveVerificationCache('user1','oidc_domain',{domain:'new.com'});
  expect(await getShownDomains('user1')).toEqual([]);
  expect(await getAvailableDomain('user1')).toBe('new.com');
});
