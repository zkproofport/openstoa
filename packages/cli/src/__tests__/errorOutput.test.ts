/** Executable-boundary API errors must not leak raw JSON into human output. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OpenStoaApiError} from '@masselabs/openstoa';
const mocks=vi.hoisted(()=>({executeOperation:vi.fn()}));
vi.mock('@masselabs/openstoa-commands',async importOriginal=>({
 ...await importOriginal<typeof import('@masselabs/openstoa-commands')>(),
 createCommands:vi.fn(async()=>({executeOperation:mocks.executeOperation})),
}));
import {main} from '../cli';
let previousExitCode:typeof process.exitCode;
beforeEach(()=>{previousExitCode=process.exitCode;});
afterEach(()=>{process.exitCode=previousExitCode;vi.restoreAllMocks();});
it('ordinary API failure prints a readable message without serializing the HTTP error payload',async()=>{
 mocks.executeOperation.mockRejectedValue(new OpenStoaApiError(403,'GET','/api/feed',{error:'This permission key cannot read the feed.',code:'api_scope_denied',required:{all:['feed:read']}}));
 const output:string[]=[];vi.spyOn(process.stderr,'write').mockImplementation(chunk=>{output.push(String(chunk));return true;});
 await main(['node','openstoa','feed']);
 expect(process.exitCode).toBe(1);
 const text=output.join('');expect(text).toContain('This permission key cannot read the feed.');
 expect(text).not.toContain('{');expect(text).not.toContain('"error"');
});
