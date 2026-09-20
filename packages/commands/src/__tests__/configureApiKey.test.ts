/** Real shared CLI/MCP construction + HTTP adapter + private temporary credential
 * persistence. HTTP is intercepted; no login or real key is submitted. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,stat,rm,readdir} from 'node:fs/promises';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCommands} from '../commands';
const key='osk_'+ 'a'.repeat(48), prior='osk_'+ 'b'.repeat(48);
const authorization={apiKeyId:'key-1',capabilities:['feed:read'],historyGrant:'none'};
const homes:string[]=[];
beforeEach(()=>{vi.stubEnv('OPENSTOA_API_KEY',undefined);vi.stubEnv('OPENSTOA_BASE_URL',undefined);});
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
async function setup(options:{savedKey?:string;loggedIn?:boolean}={}){
 const home=await mkdtemp(join(tmpdir(),'openstoa-key-selection-'));homes.push(home);
 if(options.loggedIn!==false)await writeFile(join(home,'session.json'),JSON.stringify({baseUrl:'https://openstoa.test',token:'session-test-secret',userId:'owner-1',nickname:'사용자'}),{mode:0o600});
 if(options.savedKey)await writeFile(join(home,'credentials'),JSON.stringify({apiKey:options.savedKey}),{mode:0o600});
 const fetch=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response(JSON.stringify({userId:'owner-1',nickname:'사용자',authorization}),{status:200}));vi.stubGlobal('fetch',fetch);
 const commands=await createCommands({baseUrl:'https://openstoa.test',vaultRoot:home});
 const configure=(value?:string)=>(commands as unknown as {configureApiKey(value?:string):Promise<{configured:boolean}>}).configureApiKey(value);
 return {home,fetch,commands,configure};
}
it('selects a validated key using the saved session and persists privately without returning the secret',async()=>{
 const h=await setup();const result=await h.configure(key);
 expect(result).toEqual({configured:true,...authorization});expect(JSON.stringify(result)).not.toContain(key);
 expect(String(h.fetch.mock.calls[0][0])).toBe('https://openstoa.test/api/auth/session');
 const headers=new Headers(h.fetch.mock.calls[0][1]?.headers);
 expect(headers.get('authorization')).toBe('Bearer session-test-secret');expect(headers.get('x-openstoa-api-key')).toBe(key);
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8'))).toMatchObject({apiKey:key});
 expect((await stat(join(h.home,'credentials'))).mode&0o777).toBe(0o600);
 await h.commands.whoami();expect(new Headers(h.fetch.mock.calls.at(-1)?.[1]?.headers).get('x-openstoa-api-key')).toBe(key);
});
it('a fresh logged-in vault reports no permission key without making HTTP requests',async()=>{
 const h=await setup();expect(await h.configure()).toEqual({configured:false});expect(h.fetch).not.toHaveBeenCalled();
 await expect(stat(join(h.home,'credentials'))).rejects.toMatchObject({code:'ENOENT'});
});
it('validates and persists a selected key on reuse',async()=>{
 const h=await setup({savedKey:key});
 expect(await h.configure()).toEqual({configured:true,...authorization});
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(key);
 expect((await stat(join(h.home,'credentials'))).mode&0o777).toBe(0o600);
 expect(new Headers(h.fetch.mock.calls[0][1]?.headers).get('x-openstoa-api-key')).toBe(key);
});
it('validates a zero-capability key through session rather than requiring feed/write permissions',async()=>{
 const h=await setup();h.fetch.mockResolvedValue(new Response(JSON.stringify({userId:'owner-1',nickname:'owner',authorization:{...authorization,capabilities:[]}}),{status:200}));
 expect(await h.configure(key)).toEqual({configured:true,...authorization,capabilities:[]});expect(h.fetch).toHaveBeenCalledOnce();
 expect(String(h.fetch.mock.calls[0][0])).toMatch(/\/api\/auth\/session$/);
});
it.each([{authenticated:false},{userId:'other-owner',nickname:'other'},{}])('rejects unverifiable or other-owner identity and preserves the prior key (%#)',async response=>{
 const h=await setup({savedKey:prior});h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(response),{status:200}));
 await expect(h.configure(key)).rejects.toThrow();
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(prior);
 await h.commands.whoami();expect(new Headers(h.fetch.mock.calls.at(-1)?.[1]?.headers).get('x-openstoa-api-key')).toBe(prior);
});
it.each([401,403,503])('HTTP %s validation failure preserves the existing saved and active key',async status=>{
 const h=await setup({savedKey:prior});h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({error:'Key refused'}),{status}));
 await expect(h.configure(key)).rejects.toThrow();expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(prior);
 await h.commands.whoami();expect(new Headers(h.fetch.mock.calls.at(-1)?.[1]?.headers).get('x-openstoa-api-key')).toBe(prior);
});
it.each(['',' ','not-a-key','osk_','osk_'+'a'.repeat(49),'<script>','한글🔐'])('rejects malformed key without contacting the server or destroying an old selection (%#)',async invalid=>{
 const h=await setup({savedKey:prior});await expect(h.configure(invalid)).rejects.toThrow();expect(h.fetch).not.toHaveBeenCalled();
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(prior);
});
it('never treats a permission key as login authentication',async()=>{
 const h=await setup({loggedIn:false});await expect(h.configure(key)).rejects.toThrow();expect(h.fetch).not.toHaveBeenCalled();
 await expect(stat(join(h.home,'credentials'))).rejects.toMatchObject({code:'ENOENT'});
});

it('an explicit startup key is validated with the existing login before persisting and reports exact authorization',async()=>{
 const h=await setup();const commands=await createCommands({baseUrl:'https://openstoa.test',vaultRoot:h.home,apiKey:key});
 const result=await (commands as unknown as {configureApiKey():Promise<unknown>}).configureApiKey();
 expect(result).toEqual({configured:true,...authorization});
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(key);
 expect(JSON.stringify(result)).not.toContain(key);
});

it('a credential persistence failure preserves the prior active and saved key and cleans temporary secret files',async()=>{
 const h=await setup({savedKey:prior});
 const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('disk write failed'));
 try{await expect(h.configure(key)).rejects.toThrow('disk write failed');}finally{rename.mockRestore();}
 expect(JSON.parse(await readFile(join(h.home,'credentials'),'utf8')).apiKey).toBe(prior);
 expect((await readdir(h.home)).filter(name=>name.startsWith('.credentials-'))).toEqual([]);
 await h.commands.whoami();expect(new Headers(h.fetch.mock.calls.at(-1)?.[1]?.headers).get('x-openstoa-api-key')).toBe(prior);
});
