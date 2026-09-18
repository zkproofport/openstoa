/** Read-only guest browsing remains public; writes discover the proof-login flow. */
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {middleware} from '@/middleware';
beforeEach(()=>vi.stubEnv('COMMUNITY_JWT_SECRET','test-only-jwt-signing-secret-32-bytes'));
afterEach(()=>vi.unstubAllEnvs());
const req=(path:string,method='GET',credential=false)=>new NextRequest('http://localhost:3200'+path,{method,headers:credential?{authorization:'Bearer invalid.invalid.invalid'}:{}});
describe('middleware login discovery',()=>{
 it.each(['POST','PATCH','DELETE'])('anonymous %s under guest-readable topic paths returns structured401',async(method)=>{
  const response=await middleware(req('/api/topics',method));expect(response.status).toBe(401);expect(await response.json()).toMatchObject({code:'no-credential',authentication:{status:'authentication_required',startUrl:'/api/auth/cli-login',method:'POST',docsUrl:'/docs?topic=login#login'}});
 });
 it.each(['POST','PATCH','DELETE'])('invalid-credential %s must not bypass middleware as a guest',async(method)=>{
  const response=await middleware(req('/api/topics',method,true));expect(response.status).toBe(401);expect(await response.json()).toMatchObject({code:'credential-dead',authentication:{startUrl:'/api/auth/cli-login'}});expect(response.headers.get('set-cookie')).toContain('zk-community-session');
 });
 it.each(['GET','HEAD'])('guest %s browsing remains available with or without a stale token',async(method)=>{
  for(const stale of [false,true]){const response=await middleware(req('/api/topics',method,stale));expect(response.headers.get('x-middleware-next')).toBe('1');}
 });
 it.each(['/docs?topic=login#login','/login?loginId=id','/api/auth/cli-login','/api/auth/cli-login/id'])('login documentation and entrypoint %s remain reachable without authentication',async(path)=>{
  const response=await middleware(req(path,path.startsWith('/api/')?'POST':'GET'));expect(response.headers.get('x-middleware-next')).toBe('1');expect(response.headers.get('location')).toBeNull();
 });
 it.each(['/api/auth/verify/ai','/api/auth/poll/id','/api/auth/proof-request'])('proof endpoint %s remains responsible for proof-specific errors',async(path)=>{
  const response=await middleware(req(path,'POST'));expect(response.headers.get('x-middleware-next')).toBe('1');
 });
});
