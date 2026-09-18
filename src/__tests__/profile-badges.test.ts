import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { values, session, candidates } = vi.hoisted(() => ({
  values: new Map<string, string>(), session: vi.fn(), candidates: vi.fn(),
}));
vi.mock('@/lib/dmCandidates', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/dmCandidates')>()),
  buildDmCandidatesQuery: candidates,
}));
vi.mock('@/lib/db', () => ({db:{}}));
vi.mock('@/lib/session', () => ({ getSession: session }));
vi.mock('@/lib/logger', () => ({ logger: {info:vi.fn(),warn:vi.fn()} }));
vi.mock('@/lib/redis', () => ({ redis: {
  get: async (k: string) => values.get(k) ?? null,
  mget: async (...keys: string[]) => keys.map(k => values.get(k) ?? null),
  set: async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && values.has(k)) return null;
    values.set(k,v); return 'OK';
  },
} }));
import { GET as getCandidates } from '@/app/api/dm/candidates/route';
import { GET, PATCH } from '@/app/api/profile/badges/route';
import { GET as getDomain, POST as showDomain, DELETE as hideDomain } from '@/app/api/profile/domain-badge/route';
import { getUserBadges, getBatchUserBadges, saveVerificationCache, hasValidVerificationCache } from '@/lib/verification-cache';
const request = (method='GET', body?:unknown) => new NextRequest('http://localhost/api/profile/badges', {
  method, ...(body === undefined ? {} : {body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}),
});
beforeEach(() => { values.clear(); session.mockReset().mockResolvedValue({userId:'owner'}); });
describe('profile badge controls', () => {
  it('authenticates reads and writes', async () => {
    session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect((await PATCH(request('PATCH',{type:'kyc',visible:false}))).status).toBe(401);
  });
  it('requires profile/read scope before exposing hidden owner domains to an AI key', async () => {
    await saveVerificationCache('owner','oidc_domain',{domain:'private-company.com'});
    await PATCH(request('PATCH',{type:'oidc_domain',visible:false}));
    session.mockResolvedValue({userId:'owner',isAI:true,apiKeyCmd:[]});
    for (const handler of [GET,getDomain]) {
      const response = await handler(request());
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('private-company.com');
    }
    session.mockResolvedValue({userId:'owner',isAI:true,apiKeyCmd:['/openstoa/profile/read']});
    expect((await (await GET(request())).json()).badges[0]).toMatchObject({domain:'private-company.com',visible:false});
    expect(await (await getDomain(request())).json()).toEqual({domains:[],availableDomain:'private-company.com'});
    session.mockResolvedValue({userId:'owner'});
    expect((await GET(request())).status).toBe(200);
    expect((await getDomain(request())).status).toBe(200);
  });
  it.each([null,[],{}, {type:'kyc'}, {type:'kyc',visible:'false'}, {type:'workspace',visible:false}, {type:'__proto__',visible:true}])('rejects invalid payload %j', async body => {
    expect((await PATCH(request('PATCH',body))).status).toBe(400);
    expect(values.size).toBe(0);
  });
  it('requires profile/edit scope for AI visibility mutations, including legacy domain routes', async () => {
    await saveVerificationCache('owner','oidc_domain',{domain:'company.com'});
    session.mockResolvedValue({userId:'owner',isAI:true,apiKeyCmd:['/openstoa/profile/read']});
    expect((await PATCH(request('PATCH',{type:'oidc_domain',visible:false}))).status).toBe(403);
    expect((await showDomain(request('POST'))).status).toBe(403);
    expect((await hideDomain(request('DELETE'))).status).toBe(403);
    session.mockResolvedValue({userId:'owner',isAI:true,apiKeyCmd:['/openstoa/profile/edit']});
    expect((await PATCH(request('PATCH',{type:'oidc_domain',visible:false}))).status).toBe(200);
  });
  it('rejects malformed JSON', async () => {
    const req = new NextRequest('http://localhost/api/profile/badges',{method:'PATCH',body:'{'});
    expect((await PATCH(req)).status).toBe(400);
  });
  it('rejects unverified and expired types and cannot change another user', async () => {
    await saveVerificationCache('other','kyc');
    expect((await PATCH(request('PATCH',{type:'kyc',visible:false,userId:'other'}))).status).toBe(400);
    values.set('community:verification:v2:owner:kyc',JSON.stringify({verifiedAt:1,expiresAt:2}));
    expect((await PATCH(request('PATCH',{type:'kyc',visible:true}))).status).toBe(400);
    expect(await getUserBadges('other')).toEqual([{type:'kyc',label:'KYC'}]);
  });
  it('returns owner controls with visibility and verified domain, including hidden active badges', async () => {
    await saveVerificationCache('owner','kyc');
    await saveVerificationCache('owner','oidc_domain',{domain:'company.com'});
    const response = await PATCH(request('PATCH',{type:'oidc_domain',visible:false}));
    expect(await response.json()).toEqual({success:true,type:'oidc_domain',visible:false,userId:'owner',publicBadges:[{type:'kyc',label:'KYC'}]});
    const body = await (await GET(request())).json();
    expect(body.badges).toEqual([
      {type:'kyc',verifiedAt:expect.any(Number),expiresAt:expect.any(Number),visible:true},
      {type:'oidc_domain',verifiedAt:expect.any(Number),expiresAt:expect.any(Number),visible:false,domain:'company.com'},
    ]);
    expect(await getUserBadges('owner')).toEqual([{type:'kyc',label:'KYC'}]);
    expect(await hasValidVerificationCache('owner','workspace','company.com')).toBe(true);
  });
  it.each(['none','kyc','country','workspace'])('shows all public badge types to peers in %s topics, excluding OFF', async proofType => {
    await saveVerificationCache('owner','kyc');
    await saveVerificationCache('owner','oidc_login');
    await saveVerificationCache('owner','country');
    await saveVerificationCache('owner','oidc_domain',{domain:'company.com'});
    await PATCH(request('PATCH',{type:'country',visible:false}));
    const expected = [{type:'kyc',label:'KYC'}, {type:'workspace',label:'company.com',domain:'company.com'}, {type:'oidc',label:'OIDC'}];
    expect(await getUserBadges('owner')).toEqual(expected);
    expect((await getBatchUserBadges(['owner'])).get('owner')).toEqual(expected);
    candidates.mockResolvedValue([{userId:'owner',nickname:'Owner',proofTypes:[proofType],
      sharedTopics:[{id:'shared',title:'Shared topic'}]}]);
    session.mockResolvedValue({userId:'viewer'});
    const response = await getCandidates(new NextRequest('http://localhost/api/dm/candidates'));
    expect(response.status).toBe(200);
    expect((await response.json()).candidates[0].badges).toEqual(expected);
  });
  it('uses one preference for new and legacy domain endpoints across re-verification', async () => {
    await saveVerificationCache('owner','oidc_domain',{domain:'company.com'});
    expect(await (await getDomain(request())).json()).toEqual({domains:['company.com'],availableDomain:'company.com'});
    await hideDomain(request('DELETE'));
    expect((await (await GET(request())).json()).badges[0].visible).toBe(false);
    await saveVerificationCache('owner','oidc_domain',{domain:'other.com'});
    expect(await (await getDomain(request())).json()).toEqual({domains:[],availableDomain:'other.com'});
    await showDomain(request('POST'));
    expect(await getUserBadges('owner')).toEqual([{type:'workspace',label:'other.com',domain:'other.com'}]);
    await PATCH(request('PATCH',{type:'oidc_domain',visible:false}));
    expect((await (await getDomain(request())).json()).domains).toEqual([]);
  });
});
