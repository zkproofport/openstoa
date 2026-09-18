/**
 * Independent API-wide QA: filesystem/AST inventory, explicit bootstrap/owner
 * exceptions, and runtime scoped-key enforcement. No route network/DB work.
 */
import {readdirSync,readFileSync} from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({session:vi.fn(),identity:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:mocks.session,getAuthenticatedSession:mocks.identity}));
import {ALLOWED_CMDS} from '@/lib/aiPermissions';
import {API_AUTHORIZATION_POLICIES,authorizationForRoute,authorizeApiRequest} from '@/lib/apiAuthorization';
const METHODS=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
function routeFiles(directory:string):string[]{return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?routeFiles(path.join(directory,entry.name)):entry.name==='route.ts'?[path.join(directory,entry.name)]:[]);}
const inventory=routeFiles('src/app/api').flatMap(file=>{
 const route='/api/'+path.relative('src/app/api',path.dirname(file)).split(path.sep).join('/');
 const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 return source.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&!!node.name&&METHODS.has(node.name.text)&&!!node.modifiers?.some(mod=>mod.kind===ts.SyntaxKind.ExportKeyword)).map(handler=>({file,route,method:handler.name!.text,handler}));
});
const publicPairs=new Set([
 'GET /api/auth/session','POST /api/auth/challenge','POST /api/auth/cli-login','POST /api/auth/cli-login/[loginId]',
 'POST /api/auth/dev-login','POST /api/auth/proof-request','GET /api/auth/poll/[requestId]','GET /api/auth/token-login','POST /api/auth/verify/ai',
 'POST /api/beta-signup','GET /api/health','GET /api/docs/openapi.json','GET /api/docs/proof-guide/[proofType]','GET /api/og','GET /api/og/image',
]);
const sessionPairs=new Set(['POST /api/auth/refresh','POST /api/auth/logout']);
const ownerRoutes=new Set(['/api/account','/api/auth/device/challenge','/api/keys/backup','/api/keys/tak-backup','/api/profile/api-keys','/api/profile/api-keys/[keyId]','/api/profile/ai-permissions','/api/test/clear-verification-cache']);
const ownerPairs=new Set(['POST /api/categories']);
function expectedKind(route:string,method:string){const pair=method+' '+route;if(publicPairs.has(pair))return 'public';if(sessionPairs.has(pair))return 'session';if(ownerRoutes.has(route)||ownerPairs.has(pair))return 'owner';return 'capability';}
const selected={userId:'alice',deviceKind:'agent',isAI:true,apiKeyId:'key-a',apiKeyCmd:[] as string[]};
function request(route:string,method:string,key=true){return new NextRequest('http://localhost:3200'+route,{method,headers:{authorization:'Bearer test-session',...(key?{'X-OpenStoa-API-Key':'osk_test-only'}:{})}});}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({...selected});mocks.identity.mockResolvedValue({userId:'alice'});});

describe('every exported API handler is explicitly classified and guarded first',()=>{
 it('HTTP exports cannot evade the inventory by switching to variable or re-export syntax',()=>{
  for(const file of routeFiles('src/app/api')){
   const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
   for(const statement of source.statements){
    if(ts.isVariableStatement(statement)&&statement.modifiers?.some(mod=>mod.kind===ts.SyntaxKind.ExportKeyword)){
     for(const declaration of statement.declarationList.declarations)
      expect(METHODS.has(declaration.name.getText(source)), `${file}: use an explicitly guarded exported HTTP function`).toBe(false);
    }
    if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)){
     for(const entry of statement.exportClause.elements)
      expect(METHODS.has(entry.name.text), `${file}: HTTP re-exports need a local authorization guard`).toBe(false);
    }
   }
  }
 });

 it('inventory is nonempty and has no missing or obsolete registry entries',()=>{
  expect(inventory.length).toBeGreaterThan(100);
  const actual=inventory.map(row=>row.method+' '+row.route).sort();
  const registered=Object.entries(API_AUTHORIZATION_POLICIES).flatMap(([route,methods])=>Object.keys(methods).map(method=>method+' '+route)).sort();expect(registered).toEqual(actual);
 });
 it.each(inventory)('$method $route has an intentional permission class',({route,method})=>{expect(authorizationForRoute(route,method)?.kind).toBe(expectedKind(route,method));});
 it.each(inventory)('$method $route authorizes before executing its handler',({route,handler})=>{
  const first=handler.body?.statements[0];expect(first&&ts.isVariableStatement(first)).toBe(true);if(!first||!ts.isVariableStatement(first))return;
  const declaration=first.declarationList.declarations[0];const initializer=declaration.initializer;expect(initializer&&ts.isAwaitExpression(initializer)).toBe(true);if(!initializer||!ts.isAwaitExpression(initializer))return;
  const call=initializer.expression;expect(ts.isCallExpression(call)).toBe(true);if(!ts.isCallExpression(call))return;
  expect(call.expression.getText()).toBe('authorizeApiRequest');expect(call.arguments[0].getText()).toBe(handler.parameters[0]?.name.getText());expect(ts.isStringLiteral(call.arguments[1])&&call.arguments[1].text).toBe(route);
  const second=handler.body?.statements[1];expect(second&&ts.isIfStatement(second)).toBe(true);if(!second||!ts.isIfStatement(second))return;expect(second.expression.getText()).toBe(declaration.name.getText());expect(second.thenStatement.getText()).toMatch(/return\s+authorizationError/);
 });
});

describe.each([true,false])('every selected key obeys its scope (isAI=%s)',isAI=>{
 it.each(inventory.filter(row=>!['public','session'].includes(expectedKind(row.route,row.method))))('$method $route refuses an empty selected key',async({route,method})=>{
  mocks.session.mockResolvedValue({...selected,isAI});const response=await authorizeApiRequest(request(route,method),route);expect(response?.status).toBe(403);
 });
});
it.each(inventory.filter(row=>expectedKind(row.route,row.method)==='capability'))('$method $route requires a key for a logged-in agent',async({route,method})=>{
 mocks.session.mockResolvedValue({userId:'alice',isAI:true,deviceKind:'agent'});expect((await authorizeApiRequest(request(route,method,false),route))?.status).toBe(403);
});
it.each(inventory.filter(row=>expectedKind(row.route,row.method)==='owner'))('$method $route cannot manage ownership using an agent session alone',async({route,method})=>{
 mocks.session.mockResolvedValue({userId:'alice',isAI:true,deviceKind:'agent'});expect((await authorizeApiRequest(request(route,method,false),route))?.status).toBe(403);
});
it.each(inventory.filter(row=>expectedKind(row.route,row.method)==='public'))('$method $route remains available for proof/bootstrap/public service',async({route,method})=>{
 mocks.session.mockResolvedValue(null);expect(await authorizeApiRequest(request(route,method,false),route)).toBeNull();
});
it.each(['/api/future-business-route','/api/topics/not-registered'])('an unknown business route %s fails closed for a selected key and agent',async(route)=>{
 expect(authorizationForRoute(route,'POST')).toBeUndefined();expect((await authorizeApiRequest(request(route,'POST'),route))?.status).toBe(403);
 mocks.session.mockResolvedValue({userId:'alice',isAI:true,deviceKind:'agent'});expect((await authorizeApiRequest(request(route,'POST',false),route))?.status).toBe(403);
});
it('an unregistered method cannot inherit another method permission',async()=>{expect(authorizationForRoute('/api/topics','TRACE')).toBeUndefined();expect((await authorizeApiRequest(request('/api/topics','PATCH'),'/api/topics'))?.status).toBe(403);});
it.each(['/api/topics','/api/posts/[postId]','/api/feed'])('an explicitly invalid selected key on %s never falls back to public guest access',async(route)=>{
 mocks.session.mockResolvedValue(null);const response=await authorizeApiRequest(request(route,'GET'),route);expect([401,403]).toContain(response?.status);
});
const exactScopes:[string,string,string][]=[
 ['/api/topics','GET','/openstoa/topic/read'],['/api/topics','POST','/openstoa/topic/create'],['/api/topics/[topicId]','PATCH','/openstoa/topic/edit'],['/api/topics/[topicId]','DELETE','/openstoa/topic/delete'],
 ['/api/topics/[topicId]/join','POST','/openstoa/topic/join'],['/api/topics/[topicId]/posts','GET','/openstoa/post/read'],['/api/topics/[topicId]/posts','POST','/openstoa/post/write'],
 ['/api/profile/image','PUT','/openstoa/profile/edit'],['/api/profile/nickname','PUT','/openstoa/profile/edit'],['/api/upload','POST','/openstoa/upload/write'],['/api/upload','DELETE','/openstoa/upload/delete'],
];
it.each(exactScopes)('%s %s accepts its exact scope %s and refuses unrelated grants',async(route,method,scope)=>{
 const policy=authorizationForRoute(route,method);expect(policy?.kind).toBe('capability');if(policy?.kind!=='capability')return;
 expect([...(policy.all??[]),...(policy.any??[])]).toContain(scope);
 mocks.session.mockResolvedValue({...selected,apiKeyCmd:[scope]});expect(await authorizeApiRequest(request(route,method),route)).toBeNull();
 mocks.session.mockResolvedValue({...selected,apiKeyCmd:['/openstoa/comment/read']});expect((await authorizeApiRequest(request(route,method),route))?.status).toBe(403);
});

const capabilities=inventory.filter(row=>expectedKind(row.route,row.method)==='capability');
describe.each([true,false])('all declared capabilities enforce exact key grants (isAI=%s)',isAI=>{
 it.each(capabilities)('$method $route accepts complete grants and rejects unrelated grants',async({route,method})=>{
  const policy=authorizationForRoute(route,method);expect(policy?.kind).toBe('capability');if(policy?.kind!=='capability')return;
  const all=[...(policy.all??[])],any=[...(policy.any??[])];
  expect(all.length+any.length).toBeGreaterThan(0);
  for(const scope of [...all,...any])expect(ALLOWED_CMDS).toContain(scope);
  const sufficient=[...all,...any.slice(0,1)];
  mocks.session.mockResolvedValue({...selected,isAI,deviceKind:'web',apiKeyCmd:sufficient});
  expect(await authorizeApiRequest(request(route,method),route)).toBeNull();
  const unrelated=ALLOWED_CMDS.filter(scope=>![...all,...any].includes(scope));
  mocks.session.mockResolvedValue({...selected,isAI,deviceKind:'web',apiKeyCmd:unrelated});
  const denied=await authorizeApiRequest(request(route,method),route);expect(denied?.status).toBe(403);expect((await denied!.json()).code).toBe('api_scope_denied');
  for(const missing of all){
   mocks.session.mockResolvedValue({...selected,isAI,apiKeyCmd:[...all.filter(scope=>scope!==missing),...any]});
   expect((await authorizeApiRequest(request(route,method),route))?.status).toBe(403);
  }
  for(const alternative of any){
   mocks.session.mockResolvedValue({...selected,isAI,apiKeyCmd:[...all,alternative]});
   expect(await authorizeApiRequest(request(route,method),route)).toBeNull();
  }
 });
});
it.each(inventory.filter(row=>expectedKind(row.route,row.method)==='owner'))('$method $route permits an unscoped human owner session',async({route,method})=>{
 mocks.session.mockResolvedValue({userId:'alice',isAI:false,deviceKind:'web'});expect(await authorizeApiRequest(request(route,method,false),route)).toBeNull();
});
it.each(['constructor','toString','__proto__'])('inherited method %s has no registered policy',method=>{expect(authorizationForRoute('/api/topics',method)).toBeUndefined();});
it.each([null,{userId:'alice'}])('invalid selected key distinguishes missing identity (%j)',async identity=>{
 mocks.session.mockResolvedValue(null);mocks.identity.mockResolvedValue(identity);
 const response=await authorizeApiRequest(request('/api/topics','GET'),'/api/topics');expect(response?.status).toBe(identity?403:401);expect((await response!.json()).code).toBe(identity?'api_key_invalid':'authentication_required');
});
it('authorization backend failures cannot grant guest access',async()=>{
 mocks.session.mockRejectedValue(new Error('unavailable'));const response=await authorizeApiRequest(request('/api/topics','GET'),'/api/topics');expect(response?.status).toBe(503);expect((await response!.json()).code).toBe('authorization_unavailable');
});

describe.each([true,false])('combined post/comment response scopes (isAI=%s)',isAI=>{
 it.each([['/openstoa/post/read'],['/openstoa/comment/read']])('refuses a key containing only %s',async scope=>{
  mocks.session.mockResolvedValue({...selected,isAI,deviceKind:'web',apiKeyCmd:[scope]});
  const response=await authorizeApiRequest(request('/api/posts/[postId]','GET'),'/api/posts/[postId]');expect(response?.status).toBe(403);
 });
 it('requires both grants and permits them together',async()=>{
  const scopes=['/openstoa/post/read','/openstoa/comment/read'];
  expect(authorizationForRoute('/api/posts/[postId]','GET')).toEqual({kind:'capability',all:scopes});
  mocks.session.mockResolvedValue({...selected,isAI,deviceKind:'web',apiKeyCmd:scopes});expect(await authorizeApiRequest(request('/api/posts/[postId]','GET'),'/api/posts/[postId]')).toBeNull();
 });
});

it('session discovery remains public so guests can receive authenticated=false',async()=>{
 mocks.session.mockResolvedValue(null);
 expect(authorizationForRoute('/api/auth/session','GET')).toEqual({kind:'public'});
 expect(await authorizeApiRequest(new NextRequest('http://localhost/api/auth/session'),'/api/auth/session')).toBeNull();
});
it.each(['/api/posts/[postId]/reactions','/api/posts/[postId]/records'])('guest read reaches its visibility guard: %s',async route=>{
 mocks.session.mockResolvedValue(null);
 expect(await authorizeApiRequest(new NextRequest('http://localhost'+route),route)).toBeNull();
});
