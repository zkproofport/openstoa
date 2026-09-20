/**
 * CLI/MCP login QA matrix: PKCE start/role isolation, hashed browser secret,
 * ten-minute expiry, cancel, redirects, retry/concurrency, and cryptographic
 * boundary (Google/community scope only). The verifier and relay are mocked:
 * these tests do not claim a real ZK proof was generated or verified.
 */
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {oidcIssuerInputs,proofField} from './fixtures/trusted-proof';

const mocks=vi.hoisted(()=>({
 data:new Map<string,{value:string;expires:number}>(),get:vi.fn(),set:vi.fn(),del:vi.fn(),eval:vi.fn(),
 createRelay:vi.fn(),poll:vi.fn(),verify:vi.fn(),ensureUser:vi.fn(),session:vi.fn(),cache:vi.fn(),revoke:vi.fn(),
}));
vi.mock('@/lib/sessionStore',()=>({revokeSession:mocks.revoke}));
vi.mock('@/lib/redis',()=>({redis:{get:mocks.get,set:mocks.set,del:mocks.del,eval:mocks.eval}}));
vi.mock('@/lib/relay',()=>({createRelayProofRequest:mocks.createRelay,pollProofResult:mocks.poll,RelayRequestNotFoundError:class extends Error{}}));
vi.mock('@/lib/proof',async()=>({...await vi.importActual<typeof import('@/lib/proof')>('@/lib/proof'),verifyTrustedTopicProof:mocks.verify}));
vi.mock('@/lib/ensureUser',()=>({ensureUser:mocks.ensureUser}));
vi.mock('@/lib/session',()=>({createSession:mocks.session}));
vi.mock('@/lib/verification-cache',()=>({saveVerificationCache:mocks.cache}));
import {startCliLogin,readCliLogin} from '@/lib/cliLogin';
import {computeScopeHash,COMMUNITY_SCOPE} from '@/lib/proof';

const origin='http://localhost:3200';
const verifier='v'.repeat(43);
const codeChallenge=createHash('sha256').update(verifier).digest('base64url');
function approvalToken(browserUrl:string):string {
 const url=new URL(browserUrl);const params=new URLSearchParams(url.hash.slice(1));
 const token=params.get('approvalToken');
 if(!token)throw new Error('Browser URL must carry approvalToken in its fragment');
 return token;
}
function validProof(scope=COMMUNITY_SCOPE,provider=0){
 const publicInputs=oidcIssuerInputs();
 Buffer.from(computeScopeHash(scope).slice(2),'hex').forEach((byte,index)=>{publicInputs[83+index]=proofField(byte);});
 Buffer.alloc(32,17).forEach((byte,index)=>{publicInputs[115+index]=proofField(byte);});
 publicInputs[147]=proofField(provider);
 return {status:'completed',circuit:'oidc_domain_attestation',proof:'0xaabb',publicInputs};
}
afterEach(()=>vi.useRealTimers());
beforeEach(()=>{
 vi.clearAllMocks();mocks.data.clear();
 mocks.get.mockImplementation(async(key:string)=>{const item=mocks.data.get(key);return item&&item.expires>Date.now()?item.value:null;});
 mocks.set.mockImplementation(async(key:string,value:string,...args:any[])=>{
  const item=mocks.data.get(key);if(args.includes('NX')&&item&&item.expires>Date.now())return null;
  const ex=args.indexOf('EX');const px=args.indexOf('PX');const ttl=ex>=0?Number(args[ex+1])*1000:px>=0?Number(args[px+1]):Infinity;
  mocks.data.set(key,{value,expires:Date.now()+ttl});return 'OK';
 });
 mocks.del.mockImplementation(async(key:string)=>Number(mocks.data.delete(key)));
 mocks.eval.mockImplementation(async(_script:string,_keys:number,key:string,value:string)=>{if(mocks.data.get(key)?.value===value){mocks.data.delete(key);return 1;}return 0;});
 mocks.createRelay.mockResolvedValue({requestId:'relay-login',deepLink:'zkproofport://proof-request?data=login-proof'});
 mocks.poll.mockResolvedValue({status:'pending'});mocks.verify.mockResolvedValue({valid:true});
 mocks.ensureUser.mockResolvedValue({nickname:'검증 사용자 🔐',created:false});mocks.session.mockImplementation(async(_user:string,_name:string,opts:any)=>opts?.deviceKind==='agent'?'cli-session-token':'browser-session-token');mocks.cache.mockResolvedValue(undefined);
});

describe('CLI login service contract',()=>{
 it('starts without proof generation, hashes secrets, and expires records within ten minutes',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});
  expect(started).toMatchObject({loginId:expect.any(String),browserUrl:expect.any(String),expiresAt:expect.any(Number),pollAfterMs:expect.any(Number)});
  const url=new URL(started.browserUrl);const secret=approvalToken(started.browserUrl);
  expect(url.origin).toBe(origin);expect(url.search).not.toContain(secret);expect(secret.length).toBeGreaterThanOrEqual(32);
  expect(new Date(started.expiresAt).getTime()-Date.now()).toBeGreaterThan(590000);
  expect(new Date(started.expiresAt).getTime()-Date.now()).toBeLessThanOrEqual(600000);
  const saved=[...mocks.data.values()];expect(saved.length).toBeGreaterThan(0);
  expect(saved.every(row=>row.expires-Date.now()<=600000)).toBe(true);
  expect(saved.map(row=>row.value).join()).not.toContain(secret);expect(saved.map(row=>row.value).join()).not.toContain(verifier);
  expect(mocks.createRelay).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
 });
 it.each(['', 'short', 'x'.repeat(42), 'x'.repeat(44), 'x'.repeat(43)+'=', '<script>'])('rejects malformed S256 challenges: %s',async(codeChallenge)=>{
  await expect(startCliLogin(origin,{codeChallenge})).rejects.toMatchObject({status:400});expect(mocks.data.size).toBe(0);
 });
 it.each(['https://evil.invalid/path','//evil.invalid','/\\evil.invalid','\\\\evil.invalid','javascript:alert(1)','/api/auth/session','/api','/topics?token=secret','/topics?codeVerifier=secret','/topics#token=secret','/%61pi/auth/session','/api%2Fauth/session','/%2F%2Fevil.invalid','/%5Cevil.invalid'])('refuses unsafe redirects: %s',async(redirect_url)=>{
  await expect(startCliLogin(origin,{codeChallenge,redirect_url})).rejects.toMatchObject({status:400});expect(mocks.data.size).toBe(0);
 });
 it('accepts a safe same-origin app path and preserves it through completion',async()=>{
  const started=await startCliLogin(origin,{codeChallenge,redirect_url:'/topics?sort=new'});const token=approvalToken(started.browserUrl);
  expect(await readCliLogin(started.loginId,{approvalToken:token})).toMatchObject({status:'pending',deepLink:expect.stringMatching(/^zkproofport:/)});
  mocks.poll.mockResolvedValue(validProof());const done=await readCliLogin(started.loginId,{approvalToken:token});expect(done).toMatchObject({status:'completed',redirectUrl:'/topics?sort=new'});expect(done.token).toBeUndefined();expect(done.browserToken).toBeTruthy();
 });
 it('requires one authenticated role and rejects incorrect verifier/browser secret without creating relay requests',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});
  for(const input of [{},{codeVerifier:'w'.repeat(43)},{approvalToken:'wrong'},{codeVerifier:verifier,approvalToken:approvalToken(started.browserUrl)}]){
   await expect(readCliLogin(started.loginId,input)).rejects.toMatchObject({status:403});
  }
  expect(mocks.createRelay).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
 });
 it('CLI polling cannot launch proof or obtain a token before browser approval',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'pending'});expect(mocks.createRelay).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
 });
 it('browser approval starts exactly one Google login request; retries reuse its deep link',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const input={approvalToken:approvalToken(started.browserUrl)};
  const first=await readCliLogin(started.loginId,input);const retry=await readCliLogin(started.loginId,input);
  expect(retry.deepLink).toBe(first.deepLink);expect(mocks.createRelay).toHaveBeenCalledOnce();
  expect(mocks.createRelay).toHaveBeenCalledWith(COMMUNITY_SCOPE,expect.objectContaining({circuitType:'oidc_domain_attestation'}));
  expect(mocks.createRelay.mock.calls[0][1]?.provider).toBeUndefined();
 });
 it('completes separate role sessions once and retries return only their own session',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};
  await readCliLogin(started.loginId,browser);mocks.poll.mockResolvedValue(validProof());
  const cli=await readCliLogin(started.loginId,{codeVerifier:verifier});const web=await readCliLogin(started.loginId,browser);
  expect(cli).toMatchObject({status:'completed',token:expect.any(String),userId:'0x'+'11'.repeat(32),nickname:'검증 사용자 🔐'});expect(cli.browserToken).toBeUndefined();expect(web.token).toBeUndefined();expect(web.browserToken).toBeTruthy();
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toEqual(cli);expect(await readCliLogin(started.loginId,browser)).toEqual(web);
  expect(mocks.session).toHaveBeenCalledTimes(2);expect(mocks.verify).toHaveBeenCalledOnce();
  expect(mocks.verify).toHaveBeenCalledWith('oidc_domain_attestation','0xaabb',expect.any(Array));
 });
 it.each([
  ['KYC',{...validProof(),circuit:'coinbase_attestation',publicInputs:Array(128).fill(proofField(0))}],
  ['Microsoft',validProof(COMMUNITY_SCOPE,1)],
  ['unknown provider',validProof(COMMUNITY_SCOPE,2)],
  ['topic scope',validProof('zkproofport-community:topic:alice')],
  ['missing circuit',{...validProof(),circuit:undefined}],
  ['malformed inputs',{...validProof(),publicInputs:['0x00']}],
  ['non-hex provider',{...validProof(),publicInputs:validProof().publicInputs.map((value,index)=>index===147?'0xGG':value)}],
  ['missing proof',{...validProof(),proof:undefined}],
 ])('rejects %s and never issues sessions',async(_name,result)=>{
  const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue(result);
  await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:400});expect(mocks.session).not.toHaveBeenCalled();expect(mocks.ensureUser).not.toHaveBeenCalled();
 });
 it('failed cryptographic verification never creates an account/session/cache',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue(validProof());mocks.verify.mockResolvedValue({valid:false,error:'bad proof'});
  await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:400});expect(mocks.session).not.toHaveBeenCalled();expect(mocks.ensureUser).not.toHaveBeenCalled();expect(mocks.cache).not.toHaveBeenCalled();
 });
 it('expired records reject either role without relay or session work',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});for(const row of mocks.data.values())row.expires=0;
  await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:410});await expect(readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)})).rejects.toMatchObject({status:410});expect(mocks.poll).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
 });
 it('authenticated cancellation prevents either role from completing later',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};await readCliLogin(started.loginId,browser);
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier,cancel:true})).toMatchObject({status:'cancelled'});mocks.poll.mockResolvedValue(validProof());
  for(const input of [browser,{codeVerifier:verifier}]){
   const response=await readCliLogin(started.loginId,input).catch((error:any)=>({status:error.status}));expect(['cancelled',410]).toContain(response.status);
  }
  expect(mocks.session).not.toHaveBeenCalled();
 });
 it('cancellation during verification prevents account/cache/session creation',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};await readCliLogin(started.loginId,browser);mocks.poll.mockResolvedValue(validProof());
  let finish!:(result:{valid:boolean})=>void;mocks.verify.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const verifying=readCliLogin(started.loginId,{codeVerifier:verifier});void verifying.catch(()=>{});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const cancellation=await readCliLogin(started.loginId,{...browser,cancel:true});
  finish({valid:true});const completed=await verifying.catch((error:any)=>({status:error.status}));
  expect(cancellation.status).toBe('cancelled');expect(completed.status).not.toBe('completed');
  expect(mocks.ensureUser).not.toHaveBeenCalled();expect(mocks.cache).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'cancelled'});
 });
 it('cancellation during session issuance revokes the late token and returns no credential',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};await readCliLogin(started.loginId,browser);mocks.poll.mockResolvedValue(validProof());
  let finish!:(token:string)=>void;mocks.session.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=readCliLogin(started.loginId,{codeVerifier:verifier});void pending.catch(()=>{});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  expect(await readCliLogin(started.loginId,{...browser,cancel:true})).toMatchObject({status:'cancelled'});
  const jwt=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({jti:'late-session',userId:'alice'})).toString('base64url'),'test-signature'].join('.');finish(jwt);
  await expect(pending).rejects.toMatchObject({status:409});expect(mocks.revoke).toHaveBeenCalledWith('late-session','alice');
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'cancelled'});
 });
 it('cancellation while persisting the issued token prevents its return and revokes it',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};await readCliLogin(started.loginId,browser);mocks.poll.mockResolvedValue(validProof());
  const jwt=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({jti:'persisting-session',userId:'alice'})).toString('base64url'),'test-signature'].join('.');mocks.session.mockResolvedValueOnce(jwt);
  const originalSet=mocks.set.getMockImplementation()!;let release!:()=>void;
  mocks.set.mockImplementation(async(key:string,value:string,...args:any[])=>{
   if(key===`community:cli-login:${started.loginId}`&&JSON.parse(value).token===jwt)await new Promise<void>(resolve=>{release=resolve;});
   return originalSet(key,value,...args);
  });
  const pending=readCliLogin(started.loginId,{codeVerifier:verifier});void pending.catch(()=>{});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  expect(await readCliLogin(started.loginId,{...browser,cancel:true})).toMatchObject({status:'cancelled'});release();
  await expect(pending).rejects.toMatchObject({status:409});expect(mocks.revoke).toHaveBeenCalledWith('persisting-session','alice');
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'cancelled'});
 });
 it('cancellation between issuance validation and save revokes the unpersisted token',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});const browser={approvalToken:approvalToken(started.browserUrl)};await readCliLogin(started.loginId,browser);mocks.poll.mockResolvedValue(validProof());
  const jwt=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({jti:'unsaved-session',userId:'alice'})).toString('base64url'),'test-signature'].join('.');let issued=false;let injected=false;
  mocks.session.mockImplementationOnce(async()=>{issued=true;return jwt;});
  const originalGet=mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async(key:string)=>{
   if(key.endsWith(':lock')&&issued&&!injected){injected=true;expect(await readCliLogin(started.loginId,{...browser,cancel:true})).toMatchObject({status:'cancelled'});}
   return originalGet(key);
  });
  await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:409});
  expect(injected).toBe(true);expect(mocks.revoke).toHaveBeenCalledWith('unsaved-session','alice');
 });
 it('pending retries do not extend the original ten-minute expiry',async()=>{
  vi.useFakeTimers();const started=await startCliLogin(origin,{codeChallenge});const expires=new Date(started.expiresAt).getTime();
  await vi.advanceTimersByTimeAsync(9*60*1000);await readCliLogin(started.loginId,{codeVerifier:verifier});
  expect([...mocks.data.values()].every(row=>row.expires<=expires)).toBe(true);
  await vi.advanceTimersByTimeAsync(60001);await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:410});expect(mocks.session).not.toHaveBeenCalled();
 });
 it.each(['failed','error'])('failed relay status %s never creates a session',async(status)=>{
  const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue({status});
  await expect(readCliLogin(started.loginId,{codeVerifier:verifier})).rejects.toMatchObject({status:400});expect(mocks.session).not.toHaveBeenCalled();
 });
 it('does not issue a session if the request expires during proof verification',async()=>{
  vi.useFakeTimers();const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue(validProof());
  let finish!:(result:{valid:boolean})=>void;mocks.verify.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=readCliLogin(started.loginId,{codeVerifier:verifier});void pending.catch(()=>{});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await vi.advanceTimersByTimeAsync(600001);finish({valid:true});await expect(pending).rejects.toMatchObject({status:410});expect(mocks.session).not.toHaveBeenCalled();
 });
 it('an expired Redis lock cannot let the old verifier mint a duplicate session',async()=>{
  vi.useFakeTimers();const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue(validProof());
  let finish!:(result:{valid:boolean})=>void;mocks.verify.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({valid:true});
  const first=readCliLogin(started.loginId,{codeVerifier:verifier});void first.catch(()=>{});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await vi.advanceTimersByTimeAsync(61000);const second=await readCliLogin(started.loginId,{codeVerifier:verifier});expect(second.status).toBe('completed');
  finish({valid:true});await Promise.allSettled([first]);expect(mocks.session.mock.calls.filter(call=>call[2]?.deviceKind==='agent')).toHaveLength(1);
 });
 it('uses a per-record lock so simultaneous reads cannot mint duplicate sessions',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});mocks.poll.mockResolvedValue(validProof());
  await Promise.allSettled([readCliLogin(started.loginId,{codeVerifier:verifier}),readCliLogin(started.loginId,{codeVerifier:verifier})]);
  const done=await readCliLogin(started.loginId,{codeVerifier:verifier});expect(done.status).toBe('completed');expect(mocks.session.mock.calls.filter(call=>call[2]?.deviceKind==='agent')).toHaveLength(1);
  expect(mocks.set.mock.calls.some(call=>call.includes('NX'))).toBe(true);
 });
});

describe('terminal-approved app QR handoff',()=>{
 it('explicit terminal consent creates one relay request immediately and verifier polls retain its QR without a browser',async()=>{
  const started=await startCliLogin(origin,{codeChallenge,approved:true} as Parameters<typeof startCliLogin>[1]);
  expect(started).toMatchObject({deepLink:'zkproofport://proof-request?data=login-proof'});
  expect(mocks.createRelay).toHaveBeenCalledOnce();
  for(let i=0;i<3;i++)expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'pending',deepLink:'zkproofport://proof-request?data=login-proof'});
  expect(mocks.createRelay).toHaveBeenCalledOnce();
  expect(mocks.session).not.toHaveBeenCalled();
 });
 it('legacy unapproved starts still wait for browser consent, then authenticated verifier receives the same QR',async()=>{
  const started=await startCliLogin(origin,{codeChallenge});
  expect(started).not.toHaveProperty('deepLink');
  const before=await readCliLogin(started.loginId,{codeVerifier:verifier});
  expect(before).not.toHaveProperty('deepLink');expect(mocks.createRelay).not.toHaveBeenCalled();
  const browser=await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});
  expect(await readCliLogin(started.loginId,{codeVerifier:verifier})).toMatchObject({status:'pending',deepLink:browser.deepLink});
  expect(mocks.createRelay).toHaveBeenCalledOnce();
  await expect(readCliLogin(started.loginId,{codeVerifier:'w'.repeat(43)})).rejects.toMatchObject({status:403});
  expect(mocks.session).not.toHaveBeenCalled();
 });
 it.each([false,undefined])('non-approved client value %s never creates proof before browser consent',async approved=>{
  await startCliLogin(origin,{codeChallenge,approved} as Parameters<typeof startCliLogin>[1]);
  expect(mocks.createRelay).not.toHaveBeenCalled();
 });
});

it.each(['true','false','',null,1,{},[]])('rejects malformed terminal approval instead of inferring consent (%#)',async approved=>{
 await expect(startCliLogin(origin,{codeChallenge,approved})).rejects.toMatchObject({status:400});
 expect(mocks.createRelay).not.toHaveBeenCalled();expect(mocks.data.size).toBe(0);
});
it('relay failure during terminal-approved start never persists a broken login or issues a session',async()=>{
 mocks.createRelay.mockRejectedValue(new Error('relay unavailable'));
 await expect(startCliLogin(origin,{codeChallenge,approved:true})).rejects.toThrow('relay unavailable');
 expect(mocks.data.size).toBe(0);expect(mocks.session).not.toHaveBeenCalled();
});
it('terminal-approved proof completion preserves isolated CLI and browser session roles',async()=>{
 const started=await startCliLogin(origin,{codeChallenge,approved:true});
 mocks.poll.mockResolvedValue(validProof());
 const cli=await readCliLogin(started.loginId,{codeVerifier:verifier});
 expect(cli).toMatchObject({status:'completed',token:'cli-session-token'});expect(cli).not.toHaveProperty('browserToken');
 const browser=await readCliLogin(started.loginId,{approvalToken:approvalToken(started.browserUrl)});
 expect(browser).toMatchObject({status:'completed',browserToken:'browser-session-token'});expect(browser).not.toHaveProperty('token');
 expect(mocks.createRelay).toHaveBeenCalledOnce();
});
