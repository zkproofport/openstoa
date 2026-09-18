import {NextRequest, NextResponse} from 'next/server';
import {getSession, getAuthenticatedSession} from '@/lib/session';
import {authorizationForRoute} from './apiAuthorizationPolicies';
export {API_AUTHORIZATION_POLICIES, authorizationForRoute} from './apiAuthorizationPolicies';
export type {ApiPolicy} from './apiAuthorizationPolicies';

const GUEST_READS = new Set([
 '/api/topics','/api/topics/[topicId]','/api/topics/[topicId]/posts','/api/posts/[postId]',
 '/api/posts/[postId]/reactions','/api/posts/[postId]/records',
 '/api/tags','/api/categories','/api/feed','/api/stats','/api/media/[...key]',
]);
function refused(status:number, code:string, error:string, extra:Record<string,unknown>={}) {
 return NextResponse.json({error,code,...extra},{status});
}
function loginRequired() {
 return refused(401,'authentication_required','Login required', {authentication:{status:'authentication_required',startUrl:'/api/auth/cli-login',method:'POST',cli:'openstoa login',mcp:'openstoa_authenticate',docsUrl:'/docs?topic=login#login'}});
}
/** Runs before parsing input, database mutations, storage, or opening a stream. */
export async function authorizeApiRequest(request:NextRequest, routePath:string):Promise<NextResponse|null> {
 const policy=authorizationForRoute(routePath,request.method);
 if(policy?.kind==='public')return null;
 try {
  const session=await getSession(request);
  if(!session){
   if(request.headers.has('x-openstoa-api-key')) {
    const identity=await getAuthenticatedSession(request);
    return identity ? refused(403,'api_key_invalid','The selected API key is invalid, revoked, or belongs to another account.') : loginRequired();
   }
   if(policy && request.method==='GET' && GUEST_READS.has(routePath) && !request.headers.has('authorization'))return null;
   return loginRequired();
  }
  const selectedKey = session.apiKeyId!==undefined || session.apiKeyCmd!==undefined || request.headers.has('x-openstoa-api-key');
  const agent = session.isAI===true || session.deviceKind==='agent';
  if(!policy)return refused(403,'api_policy_missing','No authorization policy is registered for this API.');
  if(policy.kind==='session')return null;
  if(policy.kind==='owner')return selectedKey||agent ? refused(403,'owner_session_required','Use the account owner’s browser or mobile login session for this operation.') : null;
  if(!selectedKey && !agent)return null;
  if(!selectedKey)return refused(403,'api_key_required','Select an API key to authorize this operation.',{authorization:{header:'X-OpenStoa-API-Key',settingsUrl:'/my',docsUrl:'/docs?topic=login#login'}});
  if(policy.kind!=='capability')return refused(403,'api_policy_missing','No capability policy is registered.');
  const allowed=new Set(session.apiKeyCmd??[]);
  const all=policy.all??[];const any=policy.any??[];
  if(all.every(cmd=>allowed.has(cmd)) && (any.length===0||any.some(cmd=>allowed.has(cmd))))return null;
  return refused(403,'api_scope_denied','The selected API key does not permit the required capability.',{required:{all,any},docsUrl:'/docs?topic=login#login'});
 }catch{
  return refused(503,'authorization_unavailable','Authorization could not be verified. Try again later.');
 }
}
