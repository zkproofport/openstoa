import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import type {Commands} from '@masselabs/openstoa-commands';
import {registerTools,type ToolResult} from '../tools';
const required={status:'proof_required',operationId:'op-1',requirement:{type:'workspace',circuitType:'oidc_domain_attestation'},methods:['app','ai'],expiresAt:'2099-01-01T00:00:00Z',message:'Proof required',pollAfterMs:1};
const cases=[{name:'openstoa_topic_create',input:{title:'T',proofType:'workspace'},core:'topicCreate'},{name:'openstoa_topic_join',input:{topicId:'t1'},core:'topicJoin'},{name:'openstoa_topic_join_invite',input:{inviteCode:'invite'},core:'executeOperation'}] as const;
function harness(){
 const decide=(input:any)=>Promise.resolve(input?.approved?{...required,status:'pending',method:input.method??'app',browserUrl:'https://openstoa.test/proof#request'}:required);
 const commands={topicCreate:vi.fn(decide),topicJoin:vi.fn((_id:string,input:any)=>decide(input)),executeOperation:vi.fn((_id:string,input:any)=>decide(input)),proofContinue:vi.fn(),proofStatus:vi.fn().mockResolvedValue({...required,status:'proof_ready'}),proofResume:vi.fn().mockResolvedValue({...required,status:'completed'}),proofCancel:vi.fn()};
 const registry=new Map<string,{schema:Record<string,z.ZodTypeAny>;run:(input:Record<string,unknown>)=>Promise<ToolResult>}>();
 registerTools({tool(name,_description,schema,run){registry.set(name,{schema,run});}},commands as unknown as Commands);
 return {commands,async call(name:string,input:Record<string,unknown>){const tool=registry.get(name)!;const result=await tool.run(z.object(tool.schema).strict().parse(input));expect(result.isError).toBeUndefined();return JSON.parse(result.content[0].text);}};
}
it.each(cases)('$name accepts proof options and returns pending without polling or duplicate continuation',async test=>{
 const h=harness();const result=await h.call(test.name,{...test.input,method:'app',provider:'microsoft',approved:true});
 expect(result).toMatchObject({status:'pending',operationId:'op-1',browserUrl:'https://openstoa.test/proof#request'});
 expect(h.commands[test.core]).toHaveBeenCalledOnce();expect(h.commands[test.core].mock.calls[0].at(-1)).toMatchObject({method:'app',provider:'microsoft',approved:true});
 expect(h.commands.proofContinue).not.toHaveBeenCalled();expect(h.commands.proofStatus).not.toHaveBeenCalled();expect(h.commands.proofResume).not.toHaveBeenCalled();
});
it.each(cases)('$name preserves lack of consent while forwarding method/provider',async test=>{
 const h=harness();const result=await h.call(test.name,{...test.input,method:'ai',provider:'google',approved:false});
 expect(result.status).toBe('proof_required');expect(h.commands[test.core].mock.calls[0].at(-1)).toMatchObject({method:'ai',provider:'google',approved:false});
 expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it.each(cases)('$name permits nonblocking approved AI and existing status/resume controls finish it',async test=>{
 const h=harness();expect((await h.call(test.name,{...test.input,method:'ai',provider:'google',approved:true})).status).toBe('pending');
 expect((await h.call('openstoa_proof_status',{operationId:'op-1'})).status).toBe('proof_ready');
 expect((await h.call('openstoa_proof_resume',{operationId:'op-1'})).status).toBe('completed');expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op-1');
 expect(h.commands[test.core]).toHaveBeenCalledOnce();
});
it.each(cases)('$name rejects malformed generation controls before dispatch',async test=>{
 for(const invalid of [{method:'invalid'},{provider:'invalid'},{approved:'true'},{wait:true}]){
  const h=harness();await expect(h.call(test.name,{...test.input,...invalid})).rejects.toThrow();expect(h.commands[test.core]).not.toHaveBeenCalled();
 }
});
