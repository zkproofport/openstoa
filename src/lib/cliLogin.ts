import {decodeJwt} from 'jose';
import {revokeSession} from './sessionStore';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {redis} from './redis';
import {createRelayProofRequest, pollProofResult, RelayRequestNotFoundError} from './relay';
import {COMMUNITY_SCOPE, computeScopeHash, extractScope, extractNullifier, normalizePublicInputs, verifyTrustedTopicProof} from './proof';
import {ensureUser} from './ensureUser';
import {createSession} from './session';
import {saveVerificationCache} from './verification-cache';

const TTL=600;
async function revokeLoginToken(token?:string){
 if(!token)return;
 const payload=decodeJwt(token);
 if(typeof payload.jti==='string')await revokeSession(payload.jti, typeof payload.userId==='string'?payload.userId:undefined);
}

const hash=(value:string)=>createHash('sha256').update(value).digest('base64url');
const equal=(a:string,b:string)=>a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class CliLoginError extends Error { constructor(public status:number,message:string){super(message);} }
interface RecordData {
  codeChallenge:string; approvalHash:string; requestId?:string; deepLink?:string;
  redirectUrl:string; expiresAt:number; approved:boolean; cancelled?:boolean;
  identity?:{userId:string;nickname:string}; token?:string; browserToken?:string;
}
export interface CliLoginState {
  status:'pending'|'completed'|'cancelled'; deepLink?:string; redirectUrl?:string;
  token?:string; browserToken?:string; userId?:string; nickname?:string; pollAfterMs?:number;
}
export function loginRedirect(value:unknown,origin:string):string {
  if(value===undefined)return '/my';
  if(typeof value!=='string'||value.length>2048||/[\\\u0000-\u0020]/.test(value)||/%(?:0[ad]|5c|2f)/i.test(value))throw new CliLoginError(400,'Invalid redirect_url');
  let url:URL;try{url=new URL(value,origin);}catch{throw new CliLoginError(400,'Invalid redirect_url');}
  if(url.origin!==new URL(origin).origin||url.username||url.password||value.startsWith('//')||
    !/^\/(?:$|my(?:\/|$)|topics(?:\/|$)|docs(?:\/|$))/.test(url.pathname)||
    ([...url.searchParams.keys()].some(key=>/token|secret|credential|code|key/i.test(key))||/token|secret|credential|code|key/i.test(url.hash)))throw new CliLoginError(400,'redirect_url must be an OpenStoa page on the same origin');
  return url.pathname+url.search+url.hash;
}
export async function startCliLogin(origin:string,input:{codeChallenge?:unknown;redirect_url?:unknown}) {
  if(typeof input.codeChallenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))throw new CliLoginError(400,'A SHA256 codeChallenge is required');
  const redirectUrl=loginRedirect(input.redirect_url,origin);
  const loginId=randomUUID(),approvalToken=randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+TTL*1000;
  const record:RecordData={codeChallenge:input.codeChallenge,approvalHash:hash(approvalToken),redirectUrl,expiresAt,approved:false};
  await redis.set(`community:cli-login:${loginId}`,JSON.stringify(record),'EX',TTL);
  const url=new URL('/login',origin);url.searchParams.set('loginId',loginId);url.hash=new URLSearchParams({approvalToken}).toString();
  return {loginId,browserUrl:url.toString(),expiresAt,pollAfterMs:2000};
}
export async function readCliLogin(loginId:string,input:{approvalToken?:unknown;codeVerifier?:unknown;cancel?:unknown}):Promise<CliLoginState> {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(loginId))throw new CliLoginError(400,'Invalid login id');
  const key=`community:cli-login:${loginId}`;
  const raw=await redis.get(key);if(!raw)throw new CliLoginError(410,'Login request expired');
  const record=JSON.parse(raw) as RecordData;
  if(record.expiresAt<=Date.now())throw new CliLoginError(410,'Login request expired');
  const browser=typeof input.approvalToken==='string';
  if(browser=== (typeof input.codeVerifier==='string'))throw new CliLoginError(403,'One login credential is required');
  if(browser ? !equal(hash(input.approvalToken as string),record.approvalHash) :
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier as string)||!equal(hash(input.codeVerifier as string),record.codeChallenge))throw new CliLoginError(403,'Invalid login credential');
  // Cancellation must not wait behind a slow cryptographic verification lock.
  if(input.cancel===true){
    await redis.set(key+':cancelled','1','EX',Math.max(1,Math.ceil((record.expiresAt-Date.now())/1000)));
    await Promise.all([revokeLoginToken(record.token),revokeLoginToken(record.browserToken)]);
    return {status:'cancelled'};
  }
  if(await redis.get(key+':cancelled'))return {status:'cancelled'};
  const lock=randomUUID();
  if(await redis.set(key+':lock',lock,'EX',60,'NX')!=='OK')return {status:'pending',pollAfterMs:2000};
  try {
    // Reload under the lock: concurrent polls/cancel must never use stale state.
    const fresh=await redis.get(key);if(!fresh)throw new CliLoginError(410,'Login request expired');
    Object.assign(record,JSON.parse(fresh));
    if(record.cancelled)return {status:'cancelled'};
    const assertCurrent=async()=>{
      if(await redis.get(key+':cancelled'))throw new CliLoginError(409,'Login cancelled');
      if(record.expiresAt<=Date.now()||!await redis.get(key))throw new CliLoginError(410,'Login request expired');
      if(await redis.get(key+':lock')!==lock)throw new CliLoginError(409,'Login is being completed; poll again');
    };
    const save=async()=>{await assertCurrent();return redis.set(key,JSON.stringify(record),'EX',Math.max(1,Math.ceil((record.expiresAt-Date.now())/1000)));};
    if(input.cancel===true){record.cancelled=true;delete record.token;delete record.browserToken;await save();return {status:'cancelled'};}
    if(browser && !record.approved){
      const relay=await createRelayProofRequest(COMMUNITY_SCOPE,{circuitType:'oidc_domain_attestation',message:'Approve Google account login for your OpenStoa CLI or AI agent'});
      Object.assign(record,relay);record.approved=true;await save();
    }
    if(!record.approved)return {status:'pending',pollAfterMs:2000};
    if(!record.identity){
      let result;try{result=await pollProofResult(record.requestId!);}catch(error){if(error instanceof RelayRequestNotFoundError)throw new CliLoginError(410,'Login proof expired');throw error;}
      if(result.status==='pending')return {status:'pending',pollAfterMs:2000,...(browser?{deepLink:record.deepLink}:{})};
      if(result.status!=='completed'||!result.proof||!result.publicInputs||result.circuit!=='oidc_domain_attestation')throw new CliLoginError(400,'Google login proof is required');
      let inputs:string[];try{inputs=normalizePublicInputs(result.publicInputs);}catch{throw new CliLoginError(400,'Invalid login proof');}
      if(inputs.length!==148||!inputs.every(value=>/^0x[0-9a-fA-F]{64}$/.test(value))||BigInt(inputs[147])!==0n||extractScope(inputs,'oidc_domain_attestation')!==computeScopeHash(COMMUNITY_SCOPE))throw new CliLoginError(400,'Login proof provider or scope mismatch');
      const verification=await verifyTrustedTopicProof('oidc_domain_attestation',result.proof,inputs);
      if(!verification.valid)throw new CliLoginError(400,'Login proof verification failed');
      await assertCurrent();
      const userId=extractNullifier(inputs,'oidc_domain_attestation');
      const {nickname}=await ensureUser(userId);
      await saveVerificationCache(userId,'oidc_login',{});
      record.identity={userId,nickname};await save();
    }
    const issueSession=async(options:Parameters<typeof createSession>[2])=>{
      await assertCurrent();
      const issued=await createSession(record.identity!.userId,record.identity!.nickname,options);
      try { await assertCurrent(); } catch(error) { await revokeLoginToken(issued); throw error; }
      return issued;
    };
    const {userId,nickname}=record.identity;
    await assertCurrent();
    const tokenField=browser?'browserToken':'token';
    let issuedHere=false;
    try {
      if(!record[tokenField]){
        record[tokenField]=await issueSession(browser
          ?{deviceKind:'web',deviceId:`cli-browser:${loginId}`}
          :{isAI:true,deviceKind:'agent',deviceId:`cli:${loginId}`});
        issuedHere=true;
        await save();
      }
      // A cancellation can race with persistence after token issuance.
      await assertCurrent();
      if(browser)return {status:'completed',userId,nickname,browserToken:record.browserToken,redirectUrl:record.redirectUrl};
      return {status:'completed',userId,nickname,token:record.token};
    }catch(error){
      if(issuedHere)await revokeLoginToken(record[tokenField]);
      throw error;
    }

  } finally {await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,key+':lock',lock);}
}
