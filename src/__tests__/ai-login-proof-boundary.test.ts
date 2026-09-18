/** A verified OIDC proof cannot acquire a caller-selected badge or provider identity. */
import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {oidcIssuerInputs,proofField} from './fixtures/trusted-proof';
const state=vi.hoisted(()=>({save:vi.fn(),session:vi.fn(),verify:vi.fn()}));
vi.mock('@/lib/proof',async()=>{const actual=await vi.importActual<typeof import('@/lib/proof')>('@/lib/proof');return {...actual,verifyTrustedTopicProof:state.verify};});
vi.mock('@/lib/challenge',()=>({consumeChallenge:async()=>Math.floor(Date.now()/1000),markPaymentTxUsed:async()=>true}));
vi.mock('@/lib/ensureUser',()=>({ensureUser:async()=>({nickname:'Alice',created:false})}));
vi.mock('@/lib/db',()=>({db:{query:{users:{findFirst:async()=>({id:'alice'})}}}}));
vi.mock('@/lib/session',()=>({createSession:state.session,setSessionCookie:vi.fn()}));
vi.mock('@/lib/verification-cache',async()=>{const actual=await vi.importActual<typeof import('@/lib/verification-cache')>('@/lib/verification-cache');return {...actual,saveVerificationCache:state.save};});
vi.mock('@/lib/redis',()=>({redis:{}}));
import {POST} from '@/app/api/auth/verify/ai/route';
import {computeScopeHash,COMMUNITY_SCOPE} from '@/lib/proof';
function proof(provider=0){const inputs=oidcIssuerInputs();Buffer.from(computeScopeHash(COMMUNITY_SCOPE).slice(2),'hex').forEach((n,i)=>inputs[83+i]=proofField(n));Buffer.from('gmail.com').forEach((n,i)=>inputs[18+i]=proofField(n));inputs[82]=proofField(9);inputs[147]=proofField(provider);return '0x'+inputs.map(v=>v.slice(2)).join('');}
const login=(circuit='oidc_domain_attestation',provider=0)=>POST(new NextRequest('http://localhost/api/auth/verify/ai',{method:'POST',body:JSON.stringify({challengeId:'challenge',result:{proof:'0xab',publicInputs:proof(provider),proofType:'google_login',circuit,verification:{valid:true,rpcUrl:'https://attacker.invalid',verifierAddress:'attacker'}}})}));
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('APP_ENV','staging');state.session.mockResolvedValue('token');state.verify.mockResolvedValue({valid:true});});
it('uses verified OIDC circuit for cache type even when result claims KYC',async()=>{expect((await login('coinbase_attestation')).status).toBe(200);expect(state.save).toHaveBeenCalledWith(expect.any(String),'oidc_login',{domain:'gmail.com'});expect(state.verify).toHaveBeenCalledWith('oidc_domain_attestation','0xab',expect.any(Array));});
it('does not let a Microsoft proof claim Google login through proofType metadata',async()=>{expect((await login('oidc_domain_attestation',1)).status).toBe(400);expect(state.session).not.toHaveBeenCalled();expect(state.save).not.toHaveBeenCalled();});
it('accepts a verified Google login',async()=>{expect((await login()).status).toBe(200);expect(state.session).toHaveBeenCalledOnce();expect(state.save).toHaveBeenCalledWith(expect.any(String),'oidc_login',{domain:'gmail.com'});});
it('does not issue a session or badge when cryptographic verification fails',async()=>{state.verify.mockResolvedValue({valid:false});expect((await login()).status).toBe(400);expect(state.session).not.toHaveBeenCalled();expect(state.save).not.toHaveBeenCalled();});
