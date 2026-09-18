/** Documentation audit: package discovery must point to authoritative usage docs,
 * and published OpenAPI must describe current auth/proof outcomes. This exercises
 * static artifacts only: no network, wallet, prover, credential or write occurs.
 * Matrix: contract invocation/result integrity covered; UTF-8 Markdown retained.
 * Input limits, races and caller roles are N/A here (route tests own enforcement).
 */
import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {OpenStoaClient} from '../../packages/sdk/src/rest/openStoaClient';

const read=(file:string)=>readFileSync(file,'utf8');
const spec=JSON.parse(read('src/generated/openapi-spec.json'));
const operation=(path:string,method:string)=>{
 const value=spec.paths[path]?.[method];
 expect(value,`${method} ${path}`).toBeDefined();
 return value;
};

describe('current package documentation',()=>{
 it.each(['sdk','commands'])('%s delegates product walkthroughs to docs rather than maintaining another manual',name=>{
  const text=read(`packages/${name}/README.md`);
  expect(text).toContain('https://www.openstoa.xyz/docs');
  expect(text).toMatch(/src\//);
  expect(text).not.toMatch(/^## (?:Quick start|API reference|Gotchas|Usage)/m);
  expect(text).not.toMatch(/also served at|API key with `isAI: true`.*capability-gated/);
 });
 it('any remaining SDK method inventory names callable methods',()=>{
  const text=read('packages/sdk/README.md');
  const client=new OpenStoaClient({baseUrl:'https://example.invalid'});
  for(const [,group,methods] of text.matchAll(/^\| `([\w]+)` \| (.+) \|$/gm)){
   if(!methods.includes('()')&&!methods.includes('(input)'))continue;
   const actual=Reflect.get(client,group);
   expect(actual,group).toBeDefined();
   for(const [,method] of methods.matchAll(/`(\w+)\(/g))expect(typeof actual?.[method],`${group}.${method}`).toBe('function');
  }
 });
 it('workspace documentation acknowledges shared server policy and operation imports',()=>{
  const text=read('packages/README.md');
  expect(read('src/lib/apiAuthorizationPolicies.ts')).toContain('packages/sdk');
  expect(read('src/lib/docs/cliReference.ts')).toContain('packages/sdk');
  expect(text).not.toMatch(/Web.*currently independent|does \*\*not\*\* affect `next build`/);
 });
 it('contract README deploy examples reference scripts that exist',()=>{
  const text=read('contracts/README.md');
  for(const [,file] of text.matchAll(/forge script ([\w/.-]+\.sol)(?::\w+)?/g))expect(existsSync(`contracts/${file}`),file).toBe(true);
 });
 it('channel docs distinguish skipped undecryptable rows from read failures',()=>{
  const text=read('packages/channel/README.md');
  expect(text).toMatch(/undecryptable[\s\S]{0,100}(?:skip|filter)|(?:skip|filter)[\s\S]{0,100}undecryptable/i);
  expect(text).not.toMatch(/per-channel failure \(thrown read, a single undecryptable message/);
  expect(text).toContain('https://www.openstoa.xyz/docs?topic=login');
 });
});

describe('published API auth and proof documentation',()=>{
 it('generated OpenAPI has no malformed null schema or response entries',()=>{
  const invalid:string[]=[];
  const visit=(value:unknown,path:string)=>{
   if(value===null){invalid.push(path);return;}
   if(Array.isArray(value)){
    value.forEach((entry,index)=>visit(entry,`${path}[${index}]`));
   }else if(typeof value==='object'){
    for(const [key,entry] of Object.entries(value)){
     // JSON payload examples/defaults may intentionally represent null. Schema
     // properties, response metadata and parsed YAML keys must be structures.
     if(['example','examples','default'].includes(key))continue;
     visit(entry,`${path}.${key}`);
    }
   }
  };
  visit(spec,'spec');
  expect(invalid,'Unquoted YAML commas can turn description fragments into null keys').toEqual([]);
 });

 it.each([['/api/profile/api-keys','post'],['/api/profile/api-keys','get'],['/api/profile/api-keys/{keyId}','patch'],['/api/profile/api-keys/{keyId}','delete']])('%s %s explains the owner session boundary', (path,method)=>{
  const text=JSON.stringify(operation(path,method));
  expect(text).not.toMatch(/caller authenticated with an API key|request authenticated with this key/);
  expect(text).toMatch(/human owner|owner.s browser|owner session/i);
 });
 it('revocation documents denied selected-key authorization rather than claiming the login was invalidated',()=>{
  const text=operation('/api/profile/api-keys/{keyId}','delete').description;
  expect(text).not.toMatch(/key gets 401/);
  expect(text).toMatch(/403|api_key_invalid/);
 });
 it.each(['/api/topics','/api/topics/{topicId}/join'])('%s documents the actual proof continuation metadata',path=>{
  const published=operation(path,'post');
  expect(published.responses['402']).toBeDefined();
  const text=JSON.stringify(published);
  expect(text).toContain('proofRequirement');
  expect(text).toContain('proofScope');
  expect(text).not.toContain('requiredProofType');
  expect(published.description).not.toMatch(/private.*join requests need owner \/ admin approval|402[^.]*missing or invalid/);
 });
 it('device challenge uses session identity rather than describing an API key as identity',()=>{
  const text=operation('/api/auth/device/challenge','get').description;
  expect(text).not.toContain('An API key already identifies the caller');
 });
 it.each(['get','put'])('retired permissions %s explains authorization before retirement',method=>{
  const published=operation('/api/profile/ai-permissions',method);
  expect(published.responses['410']).toBeDefined();
  expect(published.description).not.toMatch(/Always returns 410/);
 });
 it('nickname update describes the returned nickname without promising a replacement token',()=>{
  const published=operation('/api/profile/nickname','put');
  const fields=published.responses['200'].content['application/json'].schema.properties;
  expect(fields.nickname).toBeDefined();
  expect(fields).not.toHaveProperty('token');
  expect(published.description).not.toMatch(/includes a refreshed Bearer|resets the session cookie|must swap their stored token/);
 });
 it('legacy token login documents its actual redirect status',()=>{
  const published=operation('/api/auth/token-login','get');
  expect(published.responses['307']).toBeDefined();
  expect(published.description).not.toContain('302-redirects');
 });
});
