import {describe,it,expect,vi,afterEach} from 'vitest';
import {TopicProofWorkflow,MemoryProofOperationStore,FileProofOperationStore} from '../topicProofWorkflow';
import {promises as fs} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const scopeHash='0x54397129f0b3b0e5c469a48458023d6386775b7f54c34ae43fb6b09fc47d4ecf';
const completed={status:'completed',circuit:'coinbase_attestation',scopeHash,proof:'0xaabb',publicInputs:Array(128).fill('0x'+'01'.padStart(64,'0'))};
afterEach(()=>vi.useRealTimers());
function setup(overrides:Record<string,unknown>={}) {
 let token='credential-a';
 const request=vi.fn(async (url:string)=> {
  if(url==='/api/auth/challenge') return {scope:'zkproofport-community:topic:alice'};
  if(url==='/api/auth/proof-request') return {requestId:'relay-1',deepLink:'zkproofport://proof-request?data=abc',scope:'zkproofport-community:topic:alice',circuitType:'coinbase_attestation'};
  return {status:'pending'};
 });
 const submit=vi.fn(async()=>({id:'created-topic'}));
 const store=new MemoryProofOperationStore();
 const workflow=new TopicProofWorkflow({rest:{getToken:()=>token,request:request as any},baseUrl:'http://localhost:3200',store,submit,...overrides});
 const error={status:402,body:{proofScope:'zkproofport-community:topic:alice',proofRequirement:{type:'kyc',circuit:'coinbase_attestation'}}};
 return {workflow,store,request,submit,error,setToken:(t:string)=>{token=t;}};
}
describe('topic proof workflow',()=>{
 it('returns requirements without generating proof or submitting again',async()=>{
  const x=setup(); const r=await x.workflow.required({kind:'create',input:{title:'한국어 🔐'}},x.error);
  expect(r.status).toBe('proof_required');expect(r.operationId).toBeTruthy();expect(x.request).not.toHaveBeenCalled();expect(x.submit).not.toHaveBeenCalled();
 });
 it('requires explicit consent, binds app request, and can cancel without mutation',async()=>{
  const x=setup(); const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);
  await expect(x.workflow.continue({operationId:r.operationId,method:'app',approved:false} as any)).rejects.toThrow(/consent/i);
  const pending=await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
  expect(pending.status).toBe('pending');expect(pending.browserUrl).toMatch(/^http:\/\/localhost:3200\/proof#/);
  expect(pending.browserUrl).not.toContain('credential-a');
  expect((await x.workflow.cancel(r.operationId)).status).toBe('cancelled');
  expect((await x.workflow.resume(r.operationId)).status).toBe('cancelled');expect(x.submit).not.toHaveBeenCalled();
 });
 it('refuses another credential before contacting proof endpoints',async()=>{
  const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);x.setToken('credential-b');
  await expect(x.workflow.status(r.operationId)).rejects.toThrow(/credential/i);expect(x.request).not.toHaveBeenCalled();
 });
 it('does not treat arbitrary errors as proof requirements',async()=>{
  const x=setup();await expect(x.workflow.required({kind:'join',topicId:'topic'},{status:403,body:{error:'Invitation required'}})).rejects.toMatchObject({status:403});
 });
});

it('resumes a verified app result once and returns its original result on repeat',async()=>{
 const x=setup();const action={kind:'create' as const,input:{title:'보존할 제목',description:'내용',proof:'bad',publicInputs:'bad'}};
 const r=await x.workflow.required(action,x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 x.request.mockResolvedValue(completed as any);
 const done=await x.workflow.resume(r.operationId);expect(done.status).toBe('completed');expect(done.result).toEqual({id:'created-topic'});
 expect(x.submit).toHaveBeenCalledWith({kind:'create',input:{title:'보존할 제목',description:'내용'}},{proof:'0xaabb',publicInputs:'0x'+'1'.padStart(64,'0').repeat(128)});
 expect((await x.workflow.resume(r.operationId)).result).toEqual(done.result);expect(x.submit).toHaveBeenCalledTimes(1);
});
it('marks an ambiguous submission failed and never resubmits it',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 x.request.mockResolvedValue(completed as any);
 x.submit.mockRejectedValue(new Error('connection reset after write'));
 expect((await x.workflow.resume(r.operationId)).status).toBe('failed');expect((await x.workflow.resume(r.operationId)).status).toBe('failed');expect(x.submit).toHaveBeenCalledTimes(1);
});
it('requires provider choice and rejects a conflicting provider',async()=>{
 const x=setup();const generic={status:402,body:{...x.error.body,proofRequirement:{type:'workspace',circuit:'oidc_domain_attestation'}}};
 const r=await x.workflow.required({kind:'join',topicId:'topic'},generic);
 expect((await x.workflow.continue({operationId:r.operationId,method:'app',approved:true})).requiredInputs).toContain('provider (google or microsoft)');expect(x.request).not.toHaveBeenCalled();
 const g=await x.workflow.required({kind:'join',topicId:'topic'},{status:402,body:{...x.error.body,proofRequirement:{type:'google_workspace',circuit:'oidc_domain_attestation'}}});
 await expect(x.workflow.continue({operationId:g.operationId,method:'app',approved:true,provider:'microsoft'})).rejects.toThrow(/Provider/);
});
it('refuses a changed credential after polling, before the mutation',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 x.request.mockImplementation(async()=>{x.setToken('changed');return completed as any;});
 await expect(x.workflow.resume(r.operationId)).rejects.toThrow(/credential/i);expect(x.submit).not.toHaveBeenCalled();
});
it('does not submit a pending, malformed or wrong-circuit result',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 expect((await x.workflow.resume(r.operationId)).status).toBe('pending');
 x.request.mockResolvedValue({status:'completed',circuit:'oidc_domain_attestation',proof:'0xaabb',publicInputs:['0x01']} as any);
 await expect(x.workflow.resume(r.operationId)).rejects.toThrow(/circuit/);expect(x.submit).not.toHaveBeenCalled();
});
it('rejects a changed authenticated scope before requesting app proof',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);x.request.mockResolvedValue({scope:'other'} as any);
 await expect(x.workflow.continue({operationId:r.operationId,method:'app',approved:true})).rejects.toThrow(/scope changed/);expect(x.request).toHaveBeenCalledTimes(1);
});
it('passes country inclusion and domain/provider requirements to the existing SDK-backed route',async()=>{
 const x=setup();const e={status:402,body:{...x.error.body,proofRequirement:{type:'country',circuit:'coinbase_country_attestation',allowedCountries:['KR','US']}}};
 const r=await x.workflow.required({kind:'join',topicId:'topic'},e);
 x.request.mockImplementation(async(url:string)=>url==='/api/auth/challenge'?{scope:x.error.body.proofScope}:{scope:x.error.body.proofScope,circuitType:'coinbase_country_attestation',requestId:'id',deepLink:'zkproofport://proof-request?data=x'} as any);
 await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 expect(x.request).toHaveBeenLastCalledWith('/api/auth/proof-request',expect.objectContaining({body:{mode:'proof',circuitType:'coinbase_country_attestation',countryList:['KR','US'],isIncluded:true}}));
});

it('rejects absent or different verified scope hashes and malformed circuit input counts',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});
 for(const bad of [{...completed,scopeHash:undefined},{...completed,scopeHash:'0x'+'ff'.repeat(32)},{...completed,publicInputs:['0x01']}]){
  x.request.mockResolvedValue(bad as any);await expect(x.workflow.resume(r.operationId)).rejects.toThrow(/scope|inputs/i);
 }
 expect(x.submit).not.toHaveBeenCalled();
});
it('rechecks credential after writing the durable submission marker',async()=>{
 const x=setup();const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});x.request.mockResolvedValue(completed as any);
 const original=x.store.write.bind(x.store);vi.spyOn(x.store,'write').mockImplementation(async record=>{await original(record);if(record.state==='submitting')x.setToken('changed');});
 await x.workflow.resume(r.operationId).catch(()=>{});expect(x.submit).not.toHaveBeenCalled();
});
it('bounds ambiguous submissions and never retries after a deadline',async()=>{
 vi.useFakeTimers();const x=setup({submitTimeoutMs:50});const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});x.request.mockResolvedValue(completed as any);x.submit.mockImplementation(()=>new Promise(()=>{}));
 const pending=x.workflow.resume(r.operationId);await vi.advanceTimersByTimeAsync(51);expect((await pending).status).toBe('failed');expect((await x.workflow.resume(r.operationId)).status).toBe('failed');expect(x.submit).toHaveBeenCalledOnce();
});
it('refuses credential changes while awaiting the challenge before AI spawn',async()=>{
 const startAi=vi.fn();const x=setup({startAi});const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);
 x.request.mockImplementation(async()=>{x.setToken('changed');return {scope:x.error.body.proofScope} as any;});
 await expect(x.workflow.continue({operationId:r.operationId,method:'ai',approved:true})).rejects.toThrow(/credential/i);expect(startAi).not.toHaveBeenCalled();
});
it('cancels a newly started AI operation if pending persistence fails',async()=>{
 const cancel=vi.fn();const startAi=vi.fn(()=>({cancel,status:()=>({status:'proving'}),wait:()=>new Promise(()=>{})}));const x=setup({startAi});const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);
 vi.spyOn(x.store,'write').mockRejectedValue(new Error('disk full'));
 await expect(x.workflow.continue({operationId:r.operationId,method:'ai',approved:true})).rejects.toThrow('disk full');expect(cancel).toHaveBeenCalledOnce();
});
it('cleans failed and expired AI handles and requires explicit restart after process loss',async()=>{
 let now=100;let status='proving';const cancel=vi.fn();const handle={cancel,status:()=>({status}),wait:async()=>({proof:'0xab',publicInputs:'0x'+'00'.repeat(128*32)})};const x=setup({now:()=>now,startAi:()=>handle});
 const r=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:r.operationId,method:'ai',approved:true});status='failed';expect((await x.workflow.status(r.operationId)).status).toBe('failed');expect((x.workflow as any).ai.size).toBe(0);
 status='proving';const expired=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:expired.operationId,method:'ai',approved:true});now+=16*60*1000;expect((await x.workflow.status(expired.operationId)).status).toBe('expired');expect(cancel).toHaveBeenCalledOnce();expect((x.workflow as any).ai.size).toBe(0);
 const pending=await x.workflow.required({kind:'join',topicId:'topic'},x.error);await x.workflow.continue({operationId:pending.operationId,method:'ai',approved:true});
 const restarted=new TopicProofWorkflow({rest:{getToken:()=> 'credential-a',request:x.request as any},baseUrl:'http://localhost:3200',store:x.store,submit:x.submit,now:()=>now});expect((await restarted.status(pending.operationId)).status).toBe('proof_required');expect(x.submit).not.toHaveBeenCalled();
});
it('persists operation state privately across instances, excludes proof bytes, and rejects traversal',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'openstoa-proof-'));
 try{
  const store=new FileProofOperationStore(path.join(dir,'ops'));const x=setup({store});const r=await x.workflow.required({kind:'create',input:{title:'saved',proof:'secret-proof',publicInputs:'secret-inputs'}},x.error);
  const saved=await fs.readFile(path.join(dir,'ops',r.operationId+'.json'),'utf8');expect(saved).not.toContain('credential-a');expect(saved).not.toContain('secret-proof');expect(saved).not.toContain('secret-inputs');
  expect((await fs.stat(path.join(dir,'ops'))).mode&0o777).toBe(0o700);expect((await fs.stat(path.join(dir,'ops',r.operationId+'.json'))).mode&0o777).toBe(0o600);
  const second=new FileProofOperationStore(path.join(dir,'ops'));expect((await second.read(r.operationId)).action).toEqual({kind:'create',input:{title:'saved'}});await expect(second.read('../outside')).rejects.toThrow(/Invalid/);
  let release!:()=>void;const active=store.lock(r.operationId,()=>new Promise<void>(resolve=>{release=resolve;}));while(!release)await new Promise(resolve=>setTimeout(resolve,1));await expect(second.lock(r.operationId,async()=>{})).rejects.toThrow(/busy|lock/i);release();await active;
  await fs.writeFile(path.join(dir,'ops',r.operationId+'.json.lock'),'2147483647');const mutation=vi.fn();await expect(second.lock(r.operationId,mutation)).rejects.toThrow(/lock|busy/i);expect(mutation).not.toHaveBeenCalled();
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

it('two file-backed workflow instances resume the saved action at most once',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'openstoa-resume-'));
 try{
  const store=new FileProofOperationStore(dir);const x=setup({store});const r=await x.workflow.required({kind:'create',input:{title:'once'}},x.error);await x.workflow.continue({operationId:r.operationId,method:'app',approved:true});x.request.mockResolvedValue(completed as any);
  const restarted=new TopicProofWorkflow({rest:{getToken:()=> 'credential-a',request:x.request as any},baseUrl:'http://localhost:3200',store:new FileProofOperationStore(dir),submit:x.submit});
  await Promise.allSettled([x.workflow.resume(r.operationId),restarted.resume(r.operationId)]);expect(x.submit).toHaveBeenCalledOnce();expect((await restarted.resume(r.operationId)).status).toBe('completed');expect(x.submit).toHaveBeenCalledOnce();
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
