import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {coinbaseIssuerInputs,oidcIssuerInputs,proofField} from './fixtures/trusted-proof';
const state=vi.hoisted(()=>({poll:vi.fn(),verify:vi.fn(),session:vi.fn(),keep:vi.fn()}));
vi.mock('@/lib/oidcRequestContext',()=>({rememberBoundOidcProof:state.keep}));
vi.mock('@/lib/relay',()=>({pollProofResult:state.poll,RelayRequestNotFoundError:class extends Error{}}));
vi.mock('@/lib/proof',async()=>{const actual=await vi.importActual<typeof import('@/lib/proof')>('@/lib/proof');return {...actual,verifyProofFromRelay:state.verify};});
vi.mock('@/lib/db',()=>({db:{}}));
vi.mock('@/lib/ensureUser',()=>({ensureUser:vi.fn()}));
vi.mock('@/lib/session',()=>({createSession:state.session,setSessionCookie:vi.fn()}));
vi.mock('@/lib/deviceTakeoverGate',()=>({checkDeviceTakeover:vi.fn()}));
import {GET} from '@/app/api/auth/poll/[requestId]/route';
import {computeScopeHash} from '@/lib/proof';
const scopeHash=computeScopeHash('zkproofport-community:topic:alice');
const poll=()=>GET(new NextRequest('http://localhost/api/auth/poll/request?mode=proof&scopeHash=attacker'),{params:Promise.resolve({requestId:'request'})});
beforeEach(()=>{vi.clearAllMocks();const inputs=coinbaseIssuerInputs();Buffer.from(scopeHash.slice(2),'hex').forEach((value,index)=>inputs[64+index]=proofField(value));state.poll.mockResolvedValue({status:'completed',circuit:'coinbase_attestation',proof:'0xab',publicInputs:inputs,scopeHash:'attacker'});state.verify.mockResolvedValue({valid:true});state.keep.mockReset().mockResolvedValue(undefined);});
it('returns the committed scope from verified public inputs, ignoring relay/query claims',async()=>{const response=await poll();expect(response.status).toBe(200);expect((await response.json()).scopeHash).toBe(scopeHash);expect(state.verify).toHaveBeenCalledOnce();expect(state.session).not.toHaveBeenCalled();});
it('never emits a scope receipt for an invalid proof',async()=>{state.verify.mockResolvedValue({valid:false});const response=await poll();expect(response.status).toBe(400);expect((await response.json()).scopeHash).toBeUndefined();});
it('pending proofs have no verified scope metadata',async()=>{state.poll.mockResolvedValue({status:'pending'});expect(await (await poll()).json()).toEqual({status:'pending'});expect(state.verify).not.toHaveBeenCalled();});
it.each([undefined,''])('a verified result naming no circuit (%j) is refused, never guessed from its inputs',async(circuit)=>{state.poll.mockResolvedValue({status:'completed',circuit,proof:'0xab',publicInputs:coinbaseIssuerInputs()});const response=await poll();expect(response.status).toBe(400);expect((await response.json()).scopeHash).toBeUndefined();expect(state.session).not.toHaveBeenCalled();});
it('login poll also refuses a result naming no circuit',async()=>{state.poll.mockResolvedValue({status:'completed',proof:'0xab',publicInputs:coinbaseIssuerInputs()});const response=await GET(new NextRequest('http://localhost/api/auth/poll/request'),{params:Promise.resolve({requestId:'request'})});expect(response.status).toBe(400);expect(state.session).not.toHaveBeenCalled();});

// OIDC v2: the route verifies against the request it POLLED, and a proof-only
// poll keeps that request for the topic gate the proof goes to next.
const REQUEST={scope:'zkproofport-community:topic:alice',requestId:'request'};
const oidcResult=()=>({status:'completed',circuit:'oidc_domain_attestation',requestId:'some-other-id',proof:'0xab',publicInputs:oidcIssuerInputs({nonceMode:1,request:{scope:REQUEST.scope,requestId:'6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f'}})});
it('verifies with the polled requestId, never the one the result carries',async()=>{state.poll.mockResolvedValue(oidcResult());state.verify.mockResolvedValue({valid:true,request:REQUEST});await poll();expect(state.verify).toHaveBeenCalledWith(expect.anything(),'request');});
it('a proof-only OIDC poll keeps the request the proof was verified against',async()=>{state.poll.mockResolvedValue(oidcResult());state.verify.mockResolvedValue({valid:true,request:REQUEST});expect((await poll()).status).toBe(200);expect(state.keep).toHaveBeenCalledExactlyOnceWith('0xab',REQUEST);});
it('a proof-only OIDC poll verified without a request is a server error, never a returned proof',async()=>{state.poll.mockResolvedValue(oidcResult());state.verify.mockResolvedValue({valid:true});const response=await poll();expect(response.status).toBe(500);expect((await response.json()).proof).toBeUndefined();expect(state.keep).not.toHaveBeenCalled();});
it('a failed keep is a server error, never a returned proof',async()=>{state.poll.mockResolvedValue(oidcResult());state.verify.mockResolvedValue({valid:true,request:REQUEST});state.keep.mockRejectedValue(new Error('redis down'));const response=await poll();expect(response.status).toBe(500);expect((await response.json()).proof).toBeUndefined();});
it('a non-OIDC proof-only poll keeps nothing',async()=>{expect((await poll()).status).toBe(200);expect(state.keep).not.toHaveBeenCalled();});
