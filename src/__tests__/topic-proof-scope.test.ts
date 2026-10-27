import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
// Verification itself (pinned verifiers, issuer anchors, relay claims) is in trusted-verification.test.ts.
const state=vi.hoisted(()=>({session:null as null|{userId:string},relay:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:async()=>state.session}));
vi.mock('@/lib/relay',async()=>({...await vi.importActual<object>('@/lib/relay'),createRelayProofRequest:state.relay}));
vi.mock('@/lib/challenge',()=>({createChallenge:async()=>({challengeId:'challenge',scope:'zkproofport-community',expiresIn:300})}));
vi.mock('@/lib/redis',()=>({redis:{}}));
import {POST as challenge} from '@/app/api/auth/challenge/route';
import {POST as proofRequest} from '@/app/api/auth/proof-request/route';
const request=(body={})=>new NextRequest('http://localhost/api/auth/proof-request',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{state.session=null;vi.clearAllMocks();state.relay.mockResolvedValue({requestId:'id',deepLink:'zkproofport://test'});});
it('anonymous challenge preserves login scope',async()=>{expect((await (await challenge(request())).json()).scope).toBe('zkproofport-community');});
it('authenticated challenge is bound to API-key or browser account',async()=>{state.session={userId:'alice'};expect((await (await challenge(request())).json()).scope).toBe('zkproofport-community:topic:alice');});
it('authenticated topic request overrides caller-selected scope',async()=>{state.session={userId:'alice'};await proofRequest(request({mode:'proof',scope:'attacker',circuitType:'coinbase_attestation'}));expect(state.relay).toHaveBeenCalledWith('zkproofport-community:topic:alice',expect.anything());});
it('topic proof request requires authentication',async()=>{expect((await proofRequest(request({mode:'proof'}))).status).toBe(401);expect(state.relay).not.toHaveBeenCalled();});
it('logged-in reauthentication keeps the login scope',async()=>{state.session={userId:'alice'};await proofRequest(request({circuitType:'oidc_domain_attestation',provider:'google'}));expect(state.relay).toHaveBeenCalledWith('zkproofport-community',expect.anything());});
it.each([[undefined],[{}],[{circuitType:''}],[{circuitType:'COINBASE_ATTESTATION'}],[{circuitType:'__proto__'}],[{circuitType:'giwa_attestation'}],[{circuitType:['oidc_domain_attestation']}]])('login request with circuitType from %j is refused, never defaulted',async(body)=>{
 const res=await proofRequest(body===undefined?new NextRequest('http://localhost/api/auth/proof-request',{method:'POST'}):request(body));
 expect(res.status).toBe(400);
 expect((await res.json()).error).toMatch(/circuitType is required and must be one of: coinbase_attestation, .*mdl_kr_region/);
 expect(state.relay).not.toHaveBeenCalled();
});
it('a topic proof request with no circuitType is refused after authentication',async()=>{state.session={userId:'alice'};expect((await proofRequest(request({mode:'proof'}))).status).toBe(400);expect(state.relay).not.toHaveBeenCalled();});
