import {coinbaseIssuerInputs,oidcIssuerInputs,testJwk} from './fixtures/trusted-proof';
/** Edge matrix: malformed/empty/oversized hex; invalid verifier and RPC; cross-account scope;
 * country predicate/provider; guest/member/personal/invite refusal; cache isolation.
 * No live forged requests: route tests execute locally with DB/RPC/Redis isolated. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { computeScopeHash, COMMUNITY_SCOPE } from '@/lib/proof';
const state = vi.hoisted(() => ({ session: {userId:'alice'}, topic: {} as Record<string,unknown>, member: null as unknown, values: vi.fn(), update: vi.fn(), verify: vi.fn(), cache: new Map<string,string>() }));
vi.mock('@/lib/session',()=>({getSession:async()=>state.session}));
vi.mock('@/lib/db',()=>({db:{query:{topics:{findFirst:async()=>state.topic},topicMembers:{findFirst:async()=>state.member},categories:{findFirst:async()=>({id:'category',name:'General',slug:'general'})},joinRequests:{findFirst:async()=>({id:'request',userId:'bob',status:'pending'})}},update:()=>({set:()=>({where:state.update})}),insert:()=>({values:state.values})}}));
vi.mock('@/lib/redis',()=>({redis:{get:async(k:string)=>state.cache.get(k)??null,set:async(k:string,v:string)=>{state.cache.set(k,v);return 'OK';},mget:async()=>[]}}));
vi.mock('@/lib/chat',()=>({broadcastMembershipSystemEvent:async()=>{}}));
vi.mock('@/lib/aiPermissions',()=>({requireAiCapability:async()=>null}));
vi.mock('ethers',async()=>{const actual=await vi.importActual<typeof import('ethers')>('ethers'); return {...actual,ethers:{...actual.ethers,Contract: class {verify=state.verify;},JsonRpcProvider:class {}}};});
import { POST } from '@/app/api/topics/[topicId]/join/route';
import { PATCH as reviewRequest } from '@/app/api/topics/[topicId]/requests/route';
import { POST as createTopic } from '@/app/api/topics/route';
import { POST as inviteJoin } from '@/app/api/topics/join/[inviteCode]/route';
const id='12345678-1234-4234-8234-123456789abc';
const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function inputs(scope:string, country?:string[]) { const p=coinbaseIssuerInputs(country?150:128);const start=country?86:64;Buffer.from(computeScopeHash(scope).slice(2),'hex').forEach((n,i)=>p[start+i]=field(n));if(country){p[84]=field(country.length);p[85]=field(1);Buffer.from(country.join('')).forEach((n,i)=>p[64+i]=field(n));}return p; }
async function join(body:unknown={}) {return POST(new NextRequest('http://localhost/api/topics/'+id+'/join',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({topicId:id})});}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({keys:[testJwk]})}));vi.stubEnv('APP_ENV','staging');state.session={userId:'alice'};state.topic={id,visibility:'public',proofType:'kyc'};state.member=null;state.values.mockReset().mockImplementation(()=>({returning:async()=>[state.topic]}));state.update.mockReset();state.verify.mockReset().mockResolvedValue(true);state.cache.clear();});
describe('topic proof boundary',()=>{
 it('returns actionable replacement guidance for invalid proof without mutating membership',async()=>{state.verify.mockResolvedValue(false);const response=await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')});expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:'Invalid or unverifiable topic proof',proofScope:COMMUNITY_SCOPE+':topic:alice',proofRequirement:{type:'kyc',circuit:'coinbase_attestation'}});expect(state.values).not.toHaveBeenCalled();});
 it('does not authorize forged nonempty bytes with a matching community scope',async()=>{state.verify.mockResolvedValue(false);expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE)})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();expect(state.cache.size).toBe(0);});
 it('verifies a user-bound proof before joining, without equating Google and KYC nullifiers',async()=>{expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(201);expect(state.verify).toHaveBeenCalledOnce();expect(state.values).toHaveBeenCalledOnce();});
 it('rejects a different session scope',async()=>{expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:bob')})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();});
 it.each(['private','secret','future'])('refuses %s before any verification-cache write',async(visibility)=>{state.topic.visibility=visibility;expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE)})).status).toBe(403);expect(state.cache.size).toBe(0);expect(state.verify).not.toHaveBeenCalled();});
 it('fails closed on invalid cryptographic proof',async()=>{state.verify.mockResolvedValue(false);expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(400);expect(state.cache.size).toBe(0);expect(state.values).not.toHaveBeenCalled();});
 it('fails closed on RPC failure',async()=>{state.verify.mockRejectedValue(new Error('RPC secret'));expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();});
 it.each([null,'',' ','0x','bad','0xgg','0xa','0x'+'ab'.repeat(65537)])('rejects malformed proof %#',async(proof)=>{expect((await join({proof,publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();});
 it('does not reuse country verification for a different inclusion list',async()=>{state.topic={id,visibility:'public',proofType:'country',allowedCountries:['KR']};expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice',['KR'])})).status).toBe(201);state.topic.allowedCountries=['US'];expect((await join()).status).toBe(402);});
 it('reuses a verified identical country predicate',async()=>{state.topic={id,visibility:'public',proofType:'country',allowedCountries:['KR']};expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice',['KR'])})).status).toBe(201);expect((await join()).status).toBe(201);expect(state.verify).toHaveBeenCalledOnce();});
 it('ignores legacy unverified cache records',async()=>{state.cache.set('community:verification:alice:kyc',JSON.stringify({expiresAt:Date.now()+10000}));expect((await join()).status).toBe(402);});
});

describe('topic proof predicates and cache provenance',()=>{
 it.each([[],['bad'],Array(129).fill(field(0)),[null],42,{},'0x12'])('rejects malformed public inputs %#',async(publicInputs)=>{expect((await join({proof:'0xab',publicInputs})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();expect(state.cache.size).toBe(0);});
 it('accepts exact packed public inputs',async()=>{const publicInputs='0x'+inputs(COMMUNITY_SCOPE+':topic:alice').map(v=>v.slice(2)).join('');expect((await join({proof:'0xab',publicInputs})).status).toBe(201);});
 it('does not allow a new login cache to satisfy a topic gate',async()=>{const {saveVerificationCache}=await import('@/lib/verification-cache');await saveVerificationCache('alice','kyc');expect((await join()).status).toBe(402);});
 it('does not use another account verification cache',async()=>{await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')});state.session.userId='bob';expect((await join()).status).toBe(402);});
 it.each([[],['KR','USA'],Array(11).fill('KR'),null])('fails closed on invalid topic country predicate %#',async(allowedCountries)=>{state.topic={id,visibility:'public',proofType:'country',allowedCountries};expect((await join()).status).toBe(400);});
 it('rejects a mismatched country predicate before verification',async()=>{state.topic={id,visibility:'public',proofType:'country',allowedCountries:['US']};expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice',['KR'])})).status).toBe(400);expect(state.verify).not.toHaveBeenCalled();});
 it('refuses unknown proof types instead of falling back to OIDC',async()=>{state.topic.proofType='future';expect((await join()).status).toBe(400);});
 it.each(['personal','member','guest'])('refuses %s without touching proof state',async(kind)=>{if(kind==='personal')state.topic.personal=true;if(kind==='member')state.member={userId:'alice'};if(kind==='guest')state.session=null as never;expect([401,403,409]).toContain((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status);expect(state.cache.size).toBe(0);expect(state.verify).not.toHaveBeenCalled();});
 const workspace=(provider:number,domain='company.com')=>{const p=oidcIssuerInputs();Buffer.from(computeScopeHash(COMMUNITY_SCOPE+':topic:alice').slice(2),'hex').forEach((n,i)=>p[83+i]=field(n));Buffer.from(domain).forEach((n,i)=>p[18+i]=field(n));p[82]=field(domain.length);p[147]=field(provider);return p;};
 it('enforces provider on both fresh and cached workspace proofs',async()=>{state.topic.proofType='google_workspace';state.topic.requiredDomain='company.com';expect((await join({proof:'0xab',publicInputs:workspace(1)})).status).toBe(400);expect((await join({proof:'0xab',publicInputs:workspace(0)})).status).toBe(201);state.topic.proofType='microsoft_365';expect((await join()).status).toBe(402);});
 it('generic workspace accepts either known provider but still checks domain',async()=>{state.topic.proofType='workspace';state.topic.requiredDomain='company.com';expect((await join({proof:'0xab',publicInputs:workspace(1)})).status).toBe(201);state.topic.requiredDomain='other.com';expect((await join()).status).toBe(402);expect((await join({proof:'0xab',publicInputs:workspace(1)})).status).toBe(400);});
 it('checks circuit-specific field count',async()=>{state.topic.proofType='country';state.topic.allowedCountries=['KR'];expect((await join({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(400);});
});

describe('every topic membership entry path verifies proofs',()=>{
 const create=(body:Record<string,unknown>)=>createTopic(new NextRequest('http://localhost/api/topics',{method:'POST',body:JSON.stringify({title:'Proof topic',categoryId:'category',proofType:'kyc',...body})}));
 const invite=(body:Record<string,unknown>={})=>inviteJoin(new NextRequest('http://localhost/api/topics/join/code',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({inviteCode:'code'})});
 it.each(['create','invite'])('%s refuses missing proof with no membership/cache mutation',async(path)=>{expect((await(path==='create'?create({}):invite())).status).toBe(402);expect(state.values).not.toHaveBeenCalled();expect(state.cache.size).toBe(0);});
 it.each(['create','invite'])('%s refuses forged proof even with claimed verifier validity',async(path)=>{state.verify.mockResolvedValue(false);const body={proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice'),verification:{valid:true,verifierAddress:'attacker'}};expect((await(path==='create'?create(body):invite(body))).status).toBe(400);expect(state.values).not.toHaveBeenCalled();expect(state.cache.size).toBe(0);});
 it.each(['create','invite'])('%s accepts cryptographically verified account-bound proof',async(path)=>{const body={proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')};expect((await(path==='create'?create(body):invite(body))).status).toBe(201);expect(state.verify).toHaveBeenCalledOnce();expect(state.values).toHaveBeenCalled();});
 it('creation refuses an exclusion predicate that the topic schema cannot persist',async()=>{expect((await create({proofType:'country',countryMode:'exclude',allowedCountries:['KR'],proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice',['KR'])})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();});
});

describe('workspace gates prove an allowed email domain, not an organization subscription',()=>{
 function oidc(domain:string,provider:number) {const p=oidcIssuerInputs();Buffer.from(computeScopeHash(COMMUNITY_SCOPE+':topic:alice').slice(2),'hex').forEach((n,i)=>p[83+i]=field(n));Buffer.from(domain).forEach((n,i)=>p[18+i]=field(n));p[82]=field(domain.length);p[147]=field(provider);return p;}
 it.each([['gmail.com',0],['googlemail.com',0],['outlook.com',1],['hotmail.com',1],['live.com',1],['msn.com',1]] as const)('rejects consumer domain %s for a workspace gate',async(domain,provider)=>{state.topic.proofType='workspace';expect((await join({proof:'0xab',publicInputs:oidc(domain,provider)})).status).toBe(400);expect(state.values).not.toHaveBeenCalled();expect(state.cache.size).toBe(0);});
 it('rejects a cached consumer domain even if account-bound provenance exists',async()=>{const {saveVerificationCache}=await import('@/lib/verification-cache');await saveVerificationCache('alice','oidc_domain',{domain:'gmail.com',provider:0,topicScope:computeScopeHash(COMMUNITY_SCOPE+':topic:alice')});state.topic.proofType='workspace';expect((await join()).status).toBe(402);});
 it('continues to accept a verified custom domain matching the topic',async()=>{state.topic.proofType='google_workspace';state.topic.requiredDomain='company.com';expect((await join({proof:'0xab',publicInputs:oidc('company.com',0)})).status).toBe(201);expect((await join()).status).toBe(201);});
});

describe('legacy approvals cannot bypass requester proof requirements',()=>{
 const approve=(extra={})=>reviewRequest(new NextRequest('http://localhost/api/topics/'+id+'/requests',{method:'PATCH',body:JSON.stringify({requestId:'request',action:'approve',...extra})}),{params:Promise.resolve({topicId:id})});
 it.each(['kyc','country','workspace'])('refuses approval of an unverified %s requester',async(proofType)=>{state.topic.proofType=proofType;state.topic.allowedCountries=['KR'];state.member={role:'owner'};expect((await approve({proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:alice')})).status).toBe(402);expect(state.values).not.toHaveBeenCalled();expect(state.update).not.toHaveBeenCalled();});
 it('allows approval after the requester has verified their own proof',async()=>{const {requireTopicProof}=await import('@/lib/topic-proof');expect(await requireTopicProof('bob',{proofType:'kyc'},{proof:'0xab',publicInputs:inputs(COMMUNITY_SCOPE+':topic:bob')})).toBeNull();state.member={role:'owner'};expect((await approve()).status).toBe(200);expect(state.update).toHaveBeenCalledOnce();expect(state.values).toHaveBeenCalledWith({topicId:id,userId:'bob',role:'member'});});
 it('keeps open-topic approvals available',async()=>{state.topic.proofType='none';state.member={role:'admin'};expect((await approve()).status).toBe(200);});
});
