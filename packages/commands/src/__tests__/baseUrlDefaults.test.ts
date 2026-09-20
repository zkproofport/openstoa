/** Shared CLI/MCP origin resolution; real configuration and SDK HTTP dispatch,
 * intercepted fetch, temporary isolated vaults, no external requests. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommands} from '../commands';
const homes:string[]=[];
beforeEach(()=>{vi.stubEnv('OPENSTOA_BASE_URL',undefined);vi.stubEnv('OPENSTOA_API_KEY',undefined);});
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
async function fixture(saved?:{baseUrl:string;token?:string}){
 const home=await mkdtemp(join(tmpdir(),'openstoa-origin-test-'));homes.push(home);
 if(saved)await writeFile(join(home,'session.json'),JSON.stringify(saved),{mode:0o600});
 const fetch=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response(JSON.stringify({status:'pending',loginId:'test-login',browserUrl:new URL('/login#approvalToken=browser-secret',String(_url)).href,expiresAt:Date.now()+600000}),{status:200}));vi.stubGlobal('fetch',fetch);
 return {home,fetch};
}
it('fresh CLI/MCP vault defaults to production with no environment variable and no credentials',async()=>{
 const h=await fixture();const commands=await createCommands({vaultRoot:h.home});await commands.authenticate({method:'app',approved:true});
 expect(String(h.fetch.mock.calls[0][0])).toBe('https://www.openstoa.xyz/api/auth/cli-login');
 expect(new Headers(h.fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
});
it('preserves saved staging origin instead of changing a returning user to production',async()=>{
 const h=await fixture({baseUrl:'https://stg-community.zkproofport.app',token:'saved-test-session'});
 const commands=await createCommands({vaultRoot:h.home});await commands.authenticate({method:'app',approved:true});
 expect(String(h.fetch.mock.calls[0][0])).toBe('https://stg-community.zkproofport.app/api/auth/cli-login');
});
it('explicit environment origin overrides a saved origin',async()=>{
 const h=await fixture({baseUrl:'https://saved.example.test'});vi.stubEnv('OPENSTOA_BASE_URL','http://localhost:3200');
 const commands=await createCommands({vaultRoot:h.home});await commands.authenticate({method:'app',approved:true});
 expect(String(h.fetch.mock.calls[0][0])).toBe('http://localhost:3200/api/auth/cli-login');
});
it('explicit configuration overrides both environment and saved origin',async()=>{
 const h=await fixture({baseUrl:'https://saved.example.test'});vi.stubEnv('OPENSTOA_BASE_URL','https://env.example.test');
 const commands=await createCommands({vaultRoot:h.home,baseUrl:'https://explicit.example.test'});await commands.authenticate({method:'app',approved:true});
 expect(String(h.fetch.mock.calls[0][0])).toBe('https://explicit.example.test/api/auth/cli-login');
});
