/** Agent business requests require BOTH login and authorization; bootstrap stays usable. */
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {SignJWT} from 'jose';
import {NextRequest} from 'next/server';
import {middleware} from '@/middleware';
const secret='test-only-agent-login-and-key-signing-secret';
const rawKey='osk_'+'ab'.repeat(32);
beforeEach(()=>vi.stubEnv('COMMUNITY_JWT_SECRET',secret));afterEach(()=>vi.unstubAllEnvs());
async function token(claims={isAI:true,deviceKind:'agent'}){return new SignJWT({userId:'alice',nickname:'owner',...claims}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(secret));}
function request(path:string,method:string,headers:Record<string,string>){return new NextRequest('http://localhost:3200'+path,{method,headers});}
it.each(['/api/topics','/api/profile/me','/api/posts/post','/api/me/events'])('logged-in agent without an authorization key receives403 for business path %s',async(path)=>{
 const response=await middleware(request(path,'GET',{authorization:'Bearer '+await token()}));expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'api_key_required'});
});
it.each(['/api/auth/session','/api/auth/challenge','/api/auth/cli-login','/api/auth/refresh','/api/health','/api/docs/openapi.json'])('login/proof bootstrap path %s does not require an authorization key',async(path)=>{
 const response=await middleware(request(path,'POST',{authorization:'Bearer '+await token()}));expect(response.headers.get('x-middleware-next')).toBe('1');
});
it('an API key alone remains unauthenticated instead of bypassing JWT validation',async()=>{
 const response=await middleware(request('/api/me/events','GET',{authorization:'Bearer '+rawKey}));expect(response.status).toBe(401);expect(await response.json()).toMatchObject({authentication:{startUrl:'/api/auth/cli-login'}});
});
it('an authorization header alone never substitutes for login',async()=>{
 const response=await middleware(request('/api/topics','POST',{'X-OpenStoa-API-Key':rawKey}));expect(response.status).toBe(401);
});
it('a verified agent with both headers reaches server owner/scope validation',async()=>{
 const response=await middleware(request('/api/topics','POST',{authorization:'Bearer '+await token(),'X-OpenStoa-API-Key':rawKey}));expect(response.headers.get('x-middleware-next')).toBe('1');
});
it('a browser human session still reaches business routes without an API key',async()=>{
 const response=await middleware(request('/api/topics','POST',{authorization:'Bearer '+await token({isAI:false,deviceKind:'web'})}));expect(response.headers.get('x-middleware-next')).toBe('1');
});
it.each([{isAI:true,deviceKind:'web'},{isAI:false,deviceKind:'agent'}])('either signed agent claim requires a business key: %j',async(claims)=>{
 const response=await middleware(request('/api/topics','POST',{authorization:'Bearer '+await token(claims)}));expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'api_key_required'});
});
const keyOnlyHeaders:Record<string,string>[]=[
 {'X-OpenStoa-API-Key':rawKey},
 {authorization:'Bearer '+rawKey},
];
it.each(keyOnlyHeaders)('a key-only business request cannot masquerade as anonymous public browsing: %j',async(headers)=>{
 const response=await middleware(request('/api/topics','GET',headers));expect(response.status).toBe(401);expect(await response.json()).toMatchObject({authentication:{startUrl:'/api/auth/cli-login'}});
});
