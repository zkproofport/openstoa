import {expect,it,vi} from 'vitest';
import type {Commands} from '@masselabs/openstoa-commands';
import {buildProgram} from '../cli';
const required={status:'proof_required',operationId:'op-1',requirement:{type:'workspace',circuitType:'oidc_domain_attestation'},methods:['app','ai'],expiresAt:'2099-01-01T00:00:00Z',message:'Proof required',pollAfterMs:1};
const pending={...required,status:'pending',method:'app',browserUrl:'https://openstoa.test/proof#request'};
const cases=[
 {name:'create',args:['topics','create','--title','T','--category-id','c1','--proof-type','workspace'],core:'topicCreate'},
 {name:'join',args:['topics','join','t1'],core:'topicJoin'},
 {name:'invite',args:['topics','join-invite','invite'],core:'executeOperation'},
] as const;
function harness(tty=false){
 const decide=(input:any)=>Promise.resolve(input?.approved?{...pending,method:input.method??'app'}:required);
 const commands={topicCreate:vi.fn(decide),topicJoin:vi.fn((_id:string,input:any)=>decide(input)),executeOperation:vi.fn((_id:string,input:any)=>decide(input)),
  proofContinue:vi.fn().mockResolvedValue(pending),proofStatus:vi.fn().mockResolvedValue({...required,status:'proof_ready'}),
  proofResume:vi.fn().mockResolvedValue({...required,status:'completed',result:{id:'t1',topicId:'t1',joined:true}}),proofCancel:vi.fn().mockResolvedValue({...required,status:'cancelled'})};
 const output:string[]=[];const terminal={isTTY:()=>tty,ask:vi.fn().mockResolvedValue('yes'),write:vi.fn(),sleep:vi.fn().mockResolvedValue(undefined),openBrowser:vi.fn().mockResolvedValue(undefined)};
 const program=buildProgram(async()=>commands as unknown as Commands,value=>output.push(value),terminal);
 const guard=(c:typeof program)=>{c.exitOverride().configureOutput({writeErr:()=>{}});c.commands.forEach(guard);};guard(program);
 return {commands,terminal,output,run:(args:readonly string[])=>program.parseAsync(['node','openstoa',...args])};
}
it.each(cases)('$name --approved app without wait returns pending URL without prompting or duplicate continuation',async test=>{
 const h=harness();await h.run(['--json',...test.args,'--method','app','--approved','--provider','google']);
 const calls=h.commands[test.core].mock.calls;expect(calls).toHaveLength(1);
 expect(calls[0].at(-1)).toMatchObject({method:'app',approved:true,provider:'google'});
 expect(calls[0].at(-1)).not.toHaveProperty('wait');
 expect(JSON.parse(h.output.join(''))).toMatchObject({status:'pending',browserUrl:pending.browserUrl,operationId:'op-1'});
 expect(h.commands.proofContinue).not.toHaveBeenCalled();expect(h.commands.proofStatus).not.toHaveBeenCalled();
 expect(h.terminal.ask).not.toHaveBeenCalled();expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it.each(cases)('$name --approved --wait polls and resumes exactly once',async test=>{
 const h=harness(true);await h.run([...test.args,'--method','app','--approved','--provider','google','--wait']);
 expect(h.commands[test.core]).toHaveBeenCalledOnce();expect(h.commands.proofContinue).not.toHaveBeenCalled();
 expect(h.commands.proofStatus).toHaveBeenCalledOnce();expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op-1');
 expect(h.terminal.openBrowser).toHaveBeenCalledExactlyOnceWith(pending.browserUrl);expect(h.terminal.ask).not.toHaveBeenCalled();
 expect(h.commands[test.core].mock.calls[0].at(-1)).not.toHaveProperty('wait');
});
it.each(cases)('$name JSON wait never prompts or opens a browser on TTY',async test=>{
 const h=harness(true);await h.run(['--json',...test.args,'--approved','--method','app','--provider','google','--wait']);
 expect(JSON.parse(h.output.join('')).status).toBe('completed');expect(h.terminal.ask).not.toHaveBeenCalled();expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it.each(cases)('$name rejects approved noninteractive AI without --wait before issuing the action',async test=>{
 const h=harness();await expect(h.run([...test.args,'--method','ai','--approved','--provider','google'])).rejects.toThrow('--wait');
 expect(h.commands[test.core]).not.toHaveBeenCalled();expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it.each(cases)('$name TTY asks consent only when method and provider are already explicit',async test=>{
 const h=harness(true);await h.run([...test.args,'--method','app','--provider','microsoft']);
 expect(h.terminal.ask).toHaveBeenCalledTimes(1);
 expect(h.commands.proofContinue).toHaveBeenCalledExactlyOnceWith({operationId:'op-1',method:'app',provider:'microsoft',approved:true});
 expect(h.commands.proofResume).toHaveBeenCalledOnce();expect(h.commands[test.core]).toHaveBeenCalledOnce();
});
it.each(cases)('$name method/provider without approval in JSON remains proof_required',async test=>{
 const h=harness(true);await h.run(['--json',...test.args,'--method','app','--provider','google']);
 expect(JSON.parse(h.output.join('')).status).toBe('proof_required');expect(h.terminal.ask).not.toHaveBeenCalled();expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('plain --method app --wait asks consent first, retains app and waits in the same process',async()=>{
 const h=harness(true);h.commands.topicJoin.mockResolvedValue({...required,requirement:{type:'kyc',circuitType:'coinbase_attestation'}});
 await h.run(['topics','join','t1','--method','app','--wait']);
 expect(h.terminal.ask).toHaveBeenCalledTimes(1);expect(h.terminal.ask.mock.calls[0][0]).toMatch(/Generate this proof/);
 expect(h.commands.proofContinue).toHaveBeenCalledExactlyOnceWith({operationId:'op-1',method:'app',approved:true});
 expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op-1');expect(h.commands.topicJoin).toHaveBeenCalledOnce();
 expect(h.terminal.openBrowser).toHaveBeenCalledExactlyOnceWith(pending.browserUrl);
});
it('approved unified AI --wait prints guidance and completes without JSON prompts or browser launch',async()=>{
 const h=harness(true);
 h.commands.topicJoin.mockResolvedValue({...pending,method:'ai',browserUrl:undefined,verificationUrl:'https://google.com/device',userCode:'CODE'} as any);
 await h.run(['--json','topics','join','t1','--method','ai','--approved','--provider','google','--wait']);
 expect(h.commands.topicJoin).toHaveBeenCalledWith('t1',expect.objectContaining({method:'ai',approved:true,provider:'google'}));
 expect(h.commands.proofContinue).not.toHaveBeenCalled();expect(h.commands.proofResume).toHaveBeenCalledOnce();
 expect(h.terminal.write.mock.calls.flat().join('\n')).toContain('CODE');expect(JSON.parse(h.output.join('')).status).toBe('completed');
 expect(h.terminal.ask).not.toHaveBeenCalled();expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it.each(cases)('$name rejects invalid method/provider before core dispatch',async test=>{
 for(const args of [['--method','invalid'],['--provider','invalid']]){
  const h=harness();await expect(h.run([...test.args,...args])).rejects.toThrow();expect(h.commands[test.core]).not.toHaveBeenCalled();
 }
});
