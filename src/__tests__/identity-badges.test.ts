import { beforeEach, describe, expect, it, vi } from 'vitest';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('@/lib/verification-cache', () => ({getBatchUserBadges:lookup}));
vi.mock('@/lib/logger', () => ({logger:{warn:vi.fn()}}));
import { withPublicIdentityBadges } from '@/lib/identity-badges';
beforeEach(() => { lookup.mockReset(); });
describe('batched public identity enrichment', () => {
  it('includes KYC, OIDC and workspace regardless of topic while preserving masked/withdrawn identities', async () => {
    const badges=[{type:'kyc',label:'KYC'},{type:'oidc',label:'OIDC'},{type:'workspace',label:'company.com',domain:'company.com'}];
    lookup.mockResolvedValue(new Map([['alice',badges]]));
    const rows=[{authorId:'alice',proofType:'none'}, {authorId:'alice',proofType:'country'},
      {authorId:null,proofType:'workspace'}, {authorId:'withdrawn:1:alice',proofType:'kyc'}];
    const result=await withPublicIdentityBadges(rows,r=>r.authorId);
    expect(result.map(r=>r.badges)).toEqual([badges,badges,[],[]]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(['alice']);
    expect(result[2].authorId).toBeNull();
  });
  it('fails closed on optional badge lookup failure without preventing the underlying identity response', async () => {
    lookup.mockRejectedValue(new Error('Redis unavailable'));
    expect(await withPublicIdentityBadges([{userId:'alice'}],r=>r.userId)).toEqual([{userId:'alice',badges:[]}]);
  });
  it('does not contact Redis for an empty or fully masked list', async () => {
    expect(await withPublicIdentityBadges([],()=>null)).toEqual([]);
    expect(await withPublicIdentityBadges([{authorId:null}],r=>r.authorId)).toEqual([{authorId:null,badges:[]}]);
    expect(lookup).not.toHaveBeenCalled();
  });
});
