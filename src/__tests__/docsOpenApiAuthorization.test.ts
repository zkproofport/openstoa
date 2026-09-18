import {expect,it} from 'vitest';
import {spec} from '@/lib/swagger';
import {API_AUTHORIZATION_POLICIES,authorizationForRoute} from '../../packages/sdk/src/rest/authorizationPolicies';
import {REST_OPERATIONS} from '../../packages/sdk/src/rest/operations';
import {EXPLICIT_CLI_REFERENCE} from '@/lib/docs/cliReference';
type Security=Record<string,string[]>;
const document=spec as {components:{securitySchemes:Record<string,{type:string;in?:string;name?:string}>};security:Security[];paths:Record<string,Record<string,{security?:Security[]}>>};
it('OpenAPI declares the selected API key as a header separate from session identity',()=>{
 expect(Object.values(document.components.securitySchemes)).toContainEqual(expect.objectContaining({type:'apiKey',in:'header',name:'X-OpenStoa-API-Key'}));
});
it('OpenAPI pairs the agent identity and permission key for creating a topic',()=>{
 const keyScheme=Object.entries(document.components.securitySchemes).find(([,scheme])=>scheme.name==='X-OpenStoa-API-Key')?.[0];
 expect(keyScheme).toBeDefined();
 const security=document.paths['/api/topics'].post.security??document.security;
 expect(security.some(requirement=>Object.hasOwn(requirement,'bearerAuth')&&Object.hasOwn(requirement,keyScheme!))).toBe(true);
});
it('every published OpenAPI operation exposes the enforced registry policy',()=>{
 for(const [path,methods] of Object.entries(document.paths)){
  for(const [method,operation] of Object.entries(methods)){
   if(!['get','post','put','patch','delete'].includes(method))continue;
   const registryEntry=Object.entries(API_AUTHORIZATION_POLICIES).find(([route])=>route.replace(/\[(?:\.\.\.)?([^\]]+)\]/g,'{$1}')===path);
   const policy=registryEntry?.[1][method.toUpperCase()];
   expect.soft(policy,`${method} ${path}`).toBeDefined();
   expect.soft(Reflect.get(operation,'x-openstoa-authorization'),`${method} ${path}`).toEqual(policy);
  }
 }
});
it('every shared CLI/MCP operation has capabilities matching its enforced route policy',()=>{
 for(const operation of REST_OPERATIONS){
  const policy=authorizationForRoute(operation.path.replace(/\{([^}]+)\}/g,'[$1]'),operation.method);
  expect(policy,operation.id).toBeDefined();
  const expected=policy?.kind==='capability'?[...(policy.all??[]),...(policy.any??[])]:[];
  expect(operation.capabilities,operation.id).toEqual(expected);
 }
});
it('explicit CLI reference entries include the scopes of their direct REST operations',()=>{
 const routes=[
  ['topics list','GET','/api/topics'],['topics get','GET','/api/topics/[topicId]'],
  ['topics members','GET','/api/topics/[topicId]/members'],['topics update','PATCH','/api/topics/[topicId]'],
  ['topics create','POST','/api/topics'],['categories','GET','/api/categories'],
  ['post list','GET','/api/topics/[topicId]/posts'],['post get','GET','/api/posts/[postId]'],
  ['post create','POST','/api/topics/[topicId]/posts'],['post update','PATCH','/api/posts/[postId]'],
  ['post delete','DELETE','/api/posts/[postId]'],['comment list','GET','/api/posts/[postId]'],
  ['comment add','POST','/api/posts/[postId]/comments'],['comment delete','DELETE','/api/comments/[commentId]'],
  ['upload','POST','/api/upload'],['dm start','POST','/api/dm'],['dm list','GET','/api/dm'],
  ['profile set-nickname','PUT','/api/profile/nickname'],['profile get','GET','/api/auth/session'],
 ];
 for(const [command,method,route] of routes){
  const entry=EXPLICIT_CLI_REFERENCE.find(row=>row.command===command);
  const policy=authorizationForRoute(route,method);
  expect(entry,command).toBeDefined();expect(policy,command).toBeDefined();
  if(policy?.kind==='capability')expect(entry!.scopes,command).toEqual(expect.arrayContaining([...(policy.all??[]),...(policy.any??[])]));
 }
});
