/** Explicit login purpose must not inherit an existing account's topic scope. */
import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({session:vi.fn(),create:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:mocks.session}));
vi.mock('@/lib/challenge',()=>({createChallenge:mocks.create}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import {POST} from '@/app/api/auth/challenge/route';
import {COMMUNITY_SCOPE} from '@/lib/proof';
import {topicProofScope} from '@/lib/topic-proof';
function request(body?:unknown){return new NextRequest('http://localhost:3200/api/auth/challenge',{method:'POST',headers:{authorization:'Bearer existing-session',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({userId:'alice',isAI:true,deviceKind:'agent'});mocks.create.mockImplementation(async()=>({challengeId:'fresh',scope:COMMUNITY_SCOPE,expiresIn:300}));});
it('keeps authenticated default challenges account-bound for topic proofs',async()=>{const response=await POST(request());expect(response.status).toBe(200);expect((await response.json()).scope).toBe(topicProofScope('alice'));});
it('explicit login purpose selects community scope even with an existing agent JWT',async()=>{const response=await POST(request({purpose:'login'}));expect(response.status).toBe(200);expect(await response.json()).toEqual({challengeId:'fresh',scope:COMMUNITY_SCOPE,expiresIn:300});});
it('explicit login purpose allows unauthenticated login bootstrap',async()=>{mocks.session.mockResolvedValue(null);const response=await POST(request({purpose:'login'}));expect(response.status).toBe(200);expect((await response.json()).scope).toBe(COMMUNITY_SCOPE);});
it.each(['unexpected','',null,17,{},['login']])('refuses invalid purpose %j before creating or storing a challenge',async purpose=>{const response=await POST(request({purpose}));expect(response.status).toBe(400);expect(mocks.create).not.toHaveBeenCalled();});
