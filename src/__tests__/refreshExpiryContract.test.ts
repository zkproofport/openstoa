/** Refresh metadata must describe the JWT actually returned, without changing its session identity. */
import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {SignJWT,decodeJwt} from 'jose';
const mocks=vi.hoisted(()=>({getSession:vi.fn(),getAuthenticatedSession:vi.fn(),createSession:vi.fn(),cookie:vi.fn(),user:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:mocks.getSession,getAuthenticatedSession:mocks.getAuthenticatedSession,createSession:mocks.createSession,setSessionCookie:mocks.cookie}));
vi.mock('@/lib/db',()=>({db:{query:{users:{findFirst:mocks.user}}}}));
import {POST} from '@/app/api/auth/refresh/route';
beforeEach(()=>{vi.clearAllMocks();mocks.getAuthenticatedSession.mockImplementation(()=>mocks.getSession());mocks.getSession.mockResolvedValue({userId:'user',jti:'existing-session',deviceKind:'mobile'});mocks.user.mockResolvedValue({id:'user',nickname:'새 이름 🔐'});});
it('returns the newly minted JWT expiration in milliseconds, including its second precision',async()=>{
 const exp=Math.floor(Date.now()/1000)+90*24*60*60;
 const token=await new SignJWT({userId:'user'}).setProtectedHeader({alg:'HS256'}).setExpirationTime(exp).sign(new TextEncoder().encode('test-only-signing-material-32-bytes'));
 mocks.createSession.mockResolvedValue(token);
 const response=await POST(new NextRequest('http://localhost:3200/api/auth/refresh',{method:'POST'}));const body=await response.json();
 expect(response.status).toBe(200);expect(body.expiresAt).toBe(decodeJwt(body.token).exp!*1000);expect(body.expiresAt).toBe(exp*1000);
 expect(mocks.createSession).toHaveBeenCalledWith('user','새 이름 🔐',expect.objectContaining({sessionId:'existing-session',deviceKind:'mobile'}));expect(mocks.cookie).toHaveBeenCalledWith(response,token);
});
it('unauthenticated refresh still returns401 and creates no replacement session',async()=>{
 mocks.getSession.mockResolvedValue(null);const response=await POST(new NextRequest('http://localhost:3200/api/auth/refresh',{method:'POST'}));expect(response.status).toBe(401);expect(mocks.createSession).not.toHaveBeenCalled();
});

it.each(['web','mobile'] as const)('a selected AI key cannot rewrite the signed %s session identity on refresh',async deviceKind=>{
 const identity={userId:'user',jti:'existing-session',isAI:false,deviceKind};
 mocks.getAuthenticatedSession.mockResolvedValue(identity);
 mocks.getSession.mockResolvedValue({...identity,isAI:true,apiKeyId:'selected-ai-key',apiKeyCmd:[]});
 const token=await new SignJWT({userId:'user'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('90d').sign(new TextEncoder().encode('test-only-signing-material-32-bytes'));mocks.createSession.mockResolvedValue(token);
 const response=await POST(new NextRequest('http://localhost:3200/api/auth/refresh',{method:'POST',headers:{authorization:'Bearer original-login','X-OpenStoa-API-Key':'osk_test-only'}}));
 expect(response.status).toBe(200);expect(mocks.createSession).toHaveBeenCalledWith('user','새 이름 🔐',expect.objectContaining({sessionId:'existing-session',deviceKind,isAI:false}));
});
