/** HTTP transport contract; service/cryptography mocked, never a live login. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({start:vi.fn(),read:vi.fn(),cookie:vi.fn()}));
vi.mock('@/lib/cliLogin',()=>({
 startCliLogin:mocks.start,readCliLogin:mocks.read,
 CliLoginError:class CliLoginError extends Error{constructor(public status:number,message:string){super(message);}},
}));
vi.mock('@/lib/session',()=>({setSessionCookie:mocks.cookie}));
import {CliLoginError} from '@/lib/cliLogin';
import {POST as start} from '@/app/api/auth/cli-login/route';
import {POST as read} from '@/app/api/auth/cli-login/[loginId]/route';
const origin='http://localhost:3200';
const context={params:Promise.resolve({loginId:'login-id'})};
function request(path:string,body:unknown){return new NextRequest(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
beforeEach(()=>{
 vi.clearAllMocks();mocks.start.mockResolvedValue({loginId:'login-id',browserUrl:origin+'/login?loginId=login-id#approvalToken=browser-secret',expiresAt:'2026-09-18T10:00:00.000Z',pollAfterMs:1500});mocks.read.mockResolvedValue({status:'pending'});
 mocks.cookie.mockImplementation((response:any,token:string)=>response.cookies.set('test-session',token,{httpOnly:true}));
});
describe('CLI login HTTP role separation',()=>{
 it('starts an anonymous PKCE request with 202 and does not issue a session',async()=>{
  const body={codeChallenge:'c'.repeat(43),redirect_url:'/topics'};const response=await start(request('/api/auth/cli-login',body));
  expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(await response.json()).toEqual(await mocks.start.mock.results[0].value);expect(mocks.start).toHaveBeenCalledWith(origin,body);expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it('does not trust an arbitrary forwarded host when constructing a browser URL',async()=>{
  const req=new NextRequest(origin+'/api/auth/cli-login',{method:'POST',headers:{'content-type':'application/json','x-forwarded-host':'evil.invalid','x-forwarded-proto':'https'},body:JSON.stringify({codeChallenge:'c'.repeat(43)})});
  await start(req);expect(mocks.start.mock.calls[0][0]).toBe(origin);
 });
 it('returns 202 for CLI pending without a cookie',async()=>{
  const response=await read(request('/api/auth/cli-login/login-id',{codeVerifier:'v'.repeat(43)}),context);expect(response.status).toBe(202);expect(await response.json()).toEqual({status:'pending'});expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it('returns mobile deep link only for approved browser pending result',async()=>{
  mocks.read.mockResolvedValue({status:'pending',deepLink:'zkproofport://proof-request?data=proof'});
  const response=await read(request('/api/auth/cli-login/login-id',{approvalToken:'browser-secret'}),context);expect(response.status).toBe(202);expect(await response.json()).toMatchObject({deepLink:expect.stringMatching(/^zkproofport:/)});expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it('CLI completion returns its token in JSON and never creates a browser cookie',async()=>{
  mocks.read.mockResolvedValue({status:'completed',token:'cli-token',userId:'user',nickname:'한글 🔐'});
  const response=await read(request('/api/auth/cli-login/login-id',{codeVerifier:'v'.repeat(43)}),context);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({token:'cli-token',nickname:'한글 🔐'});expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it('browser completion sets an HttpOnly cookie and strips the internal browser token from JSON',async()=>{
  mocks.read.mockResolvedValue({status:'completed',browserToken:'cookie-only-secret',userId:'user',nickname:'browser',redirectUrl:'/my'});
  const response=await read(request('/api/auth/cli-login/login-id',{approvalToken:'browser-secret'}),context);expect(response.status).toBe(200);
  const body=await response.json();expect(body).toEqual({status:'completed',userId:'user',nickname:'browser',redirectUrl:'/my'});expect(JSON.stringify(body)).not.toContain('cookie-only-secret');expect(mocks.cookie).toHaveBeenCalledWith(response,'cookie-only-secret');expect(response.headers.get('set-cookie')).toContain('HttpOnly');
 });
 it.each([400,403,409,410])('preserves typed service refusal %i without cookies',async(status)=>{
  mocks.read.mockRejectedValue(new CliLoginError(status,'Safe refusal'));
  const response=await read(request('/api/auth/cli-login/login-id',{}),context);expect(response.status).toBe(status);expect(await response.json()).toEqual({error:'Safe refusal'});expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it.each(['start','read'])('malformed JSON produces 400 for %s',async(kind)=>{
  const req=new NextRequest(origin+'/api/auth/cli-login',{method:'POST',headers:{'content-type':'application/json'},body:'{broken'});
  const response=kind==='start'?await start(req):await read(req,context);expect(response.status).toBe(400);expect(mocks.cookie).not.toHaveBeenCalled();
 });
 it('does not leak unexpected infrastructure errors or set a session cookie',async()=>{
  mocks.read.mockRejectedValue(new Error('redis://private-password@internal-host:6379'));
  const response=await read(request('/api/auth/cli-login/login-id',{codeVerifier:'v'.repeat(43)}),context);expect(response.status).toBe(500);expect(JSON.stringify(await response.json())).not.toContain('private-password');expect(mocks.cookie).not.toHaveBeenCalled();
 });
});

it('uses the incoming Host when Docker exposes a wildcard bind address internally',async()=>{
 const req=new NextRequest('http://0.0.0.0:3200/api/auth/cli-login',{method:'POST',headers:{host:'localhost:3200','x-forwarded-proto':'http','content-type':'application/json'},body:JSON.stringify({codeChallenge:'c'.repeat(43)})});
 expect((await start(req)).status).toBe(202);expect(mocks.start.mock.calls[0][0]).toBe('http://localhost:3200');
});
it.each(['evil.invalid/path','user@evil.invalid','good.invalid,evil.invalid'])('rejects malformed incoming host %s',async host=>{
 const req=new NextRequest('http://0.0.0.0:3200/api/auth/cli-login',{method:'POST',headers:{host,'content-type':'application/json'},body:JSON.stringify({codeChallenge:'c'.repeat(43)})});
 expect((await start(req)).status).toBe(400);expect(mocks.start).not.toHaveBeenCalled();
});
