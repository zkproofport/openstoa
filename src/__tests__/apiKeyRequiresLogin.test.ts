/**
 * API keys authorize an already verified identity; they never replace login.
 * Matrix: JWT/cookie identity, expiry/logout, owner match, invalid/revoked key,
 * cookie precedence, independent key scopes, and no agent downgrade.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SignJWT} from 'jose';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({key:vi.fn(),touch:vi.fn(),user:vi.fn(),live:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{query:{users:{findFirst:mocks.user}}}}));
vi.mock('@/lib/apiKeys',()=>({isApiKeyToken:(value:string)=>value.startsWith('osk_'),verifyApiKey:mocks.key,touchApiKeyLastUsed:mocks.touch}));
vi.mock('@/lib/sessionStore',()=>({isSessionLive:mocks.live,rememberSession:vi.fn()}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
import {getSession} from '@/lib/session';
import {requireAiCapability} from '@/lib/aiPermissions';
const secret='test-only-dual-credential-signing-secret';
const rawKey='osk_'+'ab'.repeat(32);
const row={id:'key-a',userId:'alice',isAI:true,cmd:['/openstoa/post/read'],historyGrant:'none'};
async function jwt(overrides:Record<string,unknown>={},expires='1h'){
 return new SignJWT({userId:'alice',nickname:'로그인 사용자 🔐',verifiedAt:1234,deviceKind:'web',...overrides}).setProtectedHeader({alg:'HS256'}).setJti('live-session').setExpirationTime(expires).sign(new TextEncoder().encode(secret));
}
function request(headers:Record<string,string>){return new NextRequest('http://localhost:3200/api/topics',{headers});}
async function denied(value:Promise<unknown>){
 try{expect(await value).toBeNull();}catch(error){if((error as {status?:number}).status===403)return;throw error;}
}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('COMMUNITY_JWT_SECRET',secret);mocks.key.mockResolvedValue({...row});mocks.user.mockResolvedValue({id:'alice',nickname:'current-name'});mocks.live.mockResolvedValue(true);mocks.touch.mockResolvedValue(undefined);});
afterEach(()=>vi.unstubAllEnvs());
describe('API key is authorization, never login',()=>{
 it('rejects an API key used alone as Bearer authentication',async()=>{
  await denied(getSession(request({authorization:'Bearer '+rawKey})));expect(mocks.key).not.toHaveBeenCalled();expect(mocks.touch).not.toHaveBeenCalled();
 });
 it('rejects the authorization-key header without a logged-in session',async()=>{
  await denied(getSession(request({'X-OpenStoa-API-Key':rawKey})));expect(mocks.key).not.toHaveBeenCalled();
 });
 it('combines a verified Bearer JWT identity with the selected owner-matched key scope',async()=>{
  const session=await getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey}));
  expect(session).toMatchObject({userId:'alice',nickname:'로그인 사용자 🔐',jti:'live-session',verifiedAt:1234,deviceKind:'web',isAI:true,apiKeyId:'key-a',apiKeyCmd:['/openstoa/post/read'],apiKeyHistoryGrant:'none'});expect(mocks.live).toHaveBeenCalledWith('live-session');expect(mocks.key).toHaveBeenCalledWith(expect.anything(),rawKey);
 });
 it('also applies authorization scope to a cookie-authenticated owner',async()=>{
  const session=await getSession(request({cookie:'zk-community-session='+await jwt(),'X-OpenStoa-API-Key':rawKey}));expect(session?.apiKeyId).toBe('key-a');expect(session?.userId).toBe('alice');
 });
 it('does not infer any key capabilities for a JWT with no key header',async()=>{
  const session=await getSession(request({authorization:'Bearer '+await jwt({isAI:true,deviceKind:'agent'})}));expect(session).toMatchObject({userId:'alice',isAI:true,deviceKind:'agent'});expect(session?.apiKeyCmd).toBeUndefined();expect(mocks.key).not.toHaveBeenCalled();
 });
 it('refuses a different owner key without falling back to the verified session',async()=>{
  mocks.key.mockResolvedValue({...row,userId:'bob'});await denied(getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})));expect(mocks.touch).not.toHaveBeenCalled();
 });
 it.each(['revoked','unknown'])('refuses a %s key without silently dropping its scope',async()=>{
  mocks.key.mockResolvedValue(null);await denied(getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})));expect(mocks.touch).not.toHaveBeenCalled();
 });
 it.each(['','not-an-api-key'])('rejects an explicitly present malformed key header %s',async(key)=>{
  mocks.key.mockResolvedValue(null);await denied(getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':key})));
 });
 it('expired login cannot be revived by an otherwise valid key',async()=>{
  await denied(getSession(request({authorization:'Bearer '+await jwt({},'-1h'),'X-OpenStoa-API-Key':rawKey})));expect(mocks.key).not.toHaveBeenCalled();
 });
 it('logging out the session invalidates access even while the key remains active',async()=>{
  mocks.live.mockResolvedValue(false);await denied(getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})));expect(mocks.key).not.toHaveBeenCalled();expect(mocks.touch).not.toHaveBeenCalled();
 });
 it('deleted identities are not resurrected from key ownership',async()=>{
  mocks.user.mockResolvedValue(null);await denied(getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})));expect(mocks.key).not.toHaveBeenCalled();
 });
 it('preserves existing cookie precedence instead of falling back to a valid Bearer JWT',async()=>{
  await denied(getSession(request({cookie:'zk-community-session=invalid.jwt.token',authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})));expect(mocks.key).not.toHaveBeenCalled();
 });
 it('a key with isAI:false cannot downgrade an existing agent session',async()=>{
  mocks.key.mockResolvedValue({...row,isAI:false});const session=await getSession(request({authorization:'Bearer '+await jwt({isAI:true,deviceKind:'agent'}),'X-OpenStoa-API-Key':rawKey}));expect(session).toMatchObject({isAI:true,deviceKind:'agent',jti:'live-session',apiKeyId:'key-a'});
 });
 it('several keys for one logged-in identity retain independent scopes and history grants',async()=>{
  const otherKey='osk_'+'cd'.repeat(32);mocks.key.mockImplementation(async(_db,raw)=>raw===rawKey?{...row}:{...row,id:'key-b',cmd:['/openstoa/chat/send'],historyGrant:'all'});
  const token=await jwt({isAI:true,deviceKind:'agent'});const a=await getSession(request({authorization:'Bearer '+token,'X-OpenStoa-API-Key':rawKey}));const b=await getSession(request({authorization:'Bearer '+token,'X-OpenStoa-API-Key':otherKey}));
  expect(a).toMatchObject({apiKeyId:'key-a',apiKeyCmd:['/openstoa/post/read'],apiKeyHistoryGrant:'none'});expect(b).toMatchObject({apiKeyId:'key-b',apiKeyCmd:['/openstoa/chat/send'],apiKeyHistoryGrant:'all'});
  expect(await requireAiCapability({} as never,a!,'/openstoa/post/read')).toBeNull();expect((await requireAiCapability({} as never,a!,'/openstoa/chat/send'))?.status).toBe(403);expect(await requireAiCapability({} as never,b!,'/openstoa/chat/send')).toBeNull();expect((await requireAiCapability({} as never,b!,'/openstoa/post/read'))?.status).toBe(403);
 });
 it('an attached narrow key constrains a human session too',async()=>{
  mocks.key.mockResolvedValue({...row,isAI:false});const session=await getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey}));expect(session?.apiKeyCmd).toEqual(['/openstoa/post/read']);expect(await requireAiCapability({} as never,session!,'/openstoa/post/read')).toBeNull();expect((await requireAiCapability({} as never,session!,'/openstoa/chat/send'))?.status).toBe(403);
 });
 it('a key-verification outage never falls back to an unrestricted session',async()=>{
  mocks.key.mockRejectedValue(new Error('key lookup unavailable'));const outcome=await getSession(request({authorization:'Bearer '+await jwt(),'X-OpenStoa-API-Key':rawKey})).catch(()=>null);expect(outcome).toBeNull();expect(mocks.touch).not.toHaveBeenCalled();
 });
});
