import {keccak_256} from '@noble/hashes/sha3.js';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import * as path from 'node:path';
import {startAiTopicProof,type AiTopicProofHandle} from './aiTopicProof';

export type ProofMethod='app'|'ai';
export type ProofProvider='google'|'microsoft';
export interface ProofRequirement {type:string;circuitType:string;domain?:string;allowedCountries?:string[]}
export interface ProofWorkflowResult {
 status:'proof_required'|'pending'|'proof_ready'|'completed'|'cancelled'|'expired'|'failed';
 operationId:string;requirement:ProofRequirement;methods:ProofMethod[];expiresAt:string;message:string;
 requiredInputs?:string[];provider?:ProofProvider;method?:ProofMethod;browserUrl?:string;deepLink?:string;
 verificationUrl?:string;userCode?:string;pollAfterMs:number;result?:unknown;
}
export function isProofWorkflowResult(value:unknown):value is ProofWorkflowResult {
 return !!value&&typeof value==='object'&&typeof (value as ProofWorkflowResult).operationId==='string'
  &&['proof_required','pending','proof_ready','completed','cancelled','expired','failed'].includes((value as ProofWorkflowResult).status);
}
export type ProofAction={kind:'create';input:Record<string,unknown>}|{kind:'join';topicId:string}|{kind:'invite';input:Record<string,unknown>};
export interface ProofContinueInput {operationId:string;method:ProofMethod;approved:true;provider?:ProofProvider}
interface Operation {
 version:1;id:string;action:ProofAction;fingerprint:string;baseUrl:string;scope:string;requirement:ProofRequirement;
 expiresAt:number;state:ProofWorkflowResult['status']|'submitting';method?:ProofMethod;provider?:ProofProvider;
 requestId?:string;deepLink?:string;message?:string;result?:unknown;
}
export interface ProofOperationStore {
 read(id:string):Promise<Operation>;write(record:Operation):Promise<void>;
 lock<T>(id:string,fn:()=>Promise<T>):Promise<T>;
}
export class MemoryProofOperationStore implements ProofOperationStore {
 private records=new Map<string,Operation>();private locks=new Set<string>();
 async read(id:string){const record=this.records.get(id);if(!record)throw new Error('Unknown proof operation');return structuredClone(record);}
 async write(record:Operation){this.records.set(record.id,structuredClone(record));}
 async lock<T>(id:string,fn:()=>Promise<T>):Promise<T>{if(this.locks.has(id))throw new Error('Proof operation is busy; retry status shortly');this.locks.add(id);try{return await fn();}finally{this.locks.delete(id);}}
}
/** Private operation files exclude account credentials, private keys, and proof bytes. Invite actions retain their invite code. */
export class FileProofOperationStore implements ProofOperationStore {
 constructor(private readonly directory:string){}
 private file(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid proof operation ID');return path.join(this.directory,`${id}.json`);}
 async read(id:string):Promise<Operation>{try{return JSON.parse(await fs.readFile(this.file(id),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Unknown proof operation; use the same vault directory');throw e;}}
 async write(record:Operation){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const dest=this.file(record.id);const tmp=`${dest}.${randomUUID()}.tmp`;await fs.writeFile(tmp,JSON.stringify(record),{mode:0o600});await fs.rename(tmp,dest);}
 async lock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const file=this.file(id)+'.lock';
  let handle;
  try{handle=await fs.open(file,'wx',0o600);}catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   // Never delete another process's lock, even if its recorded PID is dead:
   // concurrent stale-lock reclamation can admit two mutation owners.
   throw new Error('Proof operation is locked. If its process crashed, inspect the original action before starting a new operation; this operation will not be resumed automatically.');
  }
  try{await handle.writeFile(String(process.pid));return await fn();}finally{await handle.close();await fs.unlink(file).catch(()=>{});}
 }
}
interface Rest {getApiKey?():string|null;getToken():string|null;request<T=any>(url:string,options?:any):Promise<T>}
interface WorkflowDeps {rest:Rest;baseUrl:string;store:ProofOperationStore;submit:(action:ProofAction,proof:{proof:string;publicInputs:string})=>Promise<unknown>;now?:()=>number;startAi?:typeof startAiTopicProof;submitTimeoutMs?:number}
const CIRCUITS:Record<string,string>={kyc:'coinbase_attestation',country:'coinbase_country_attestation',google_workspace:'oidc_domain_attestation',microsoft_365:'oidc_domain_attestation',workspace:'oidc_domain_attestation'};
const TTL=15*60*1000;
const TERMINAL=new Set(['completed','cancelled','expired','failed']);
function normalizedProof(value:any,circuit:string):{proof:string;publicInputs:string}{
 if(!value||typeof value.proof!=='string'||!/^0x(?:[a-f0-9]{2})+$/i.test(value.proof)||value.proof.length>131074)throw new Error('Invalid proof result');
 let inputs=value.publicInputs;
 if(Array.isArray(inputs)&&inputs.every((v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{1,64}$/i.test(v)))inputs='0x'+inputs.map((v:string)=>v.slice(2).padStart(64,'0')).join('');
 const count=({coinbase_attestation:128,coinbase_country_attestation:150,oidc_domain_attestation:148} as Record<string,number>)[circuit];
 if(!count||typeof inputs!=='string'||!/^0x(?:[a-f0-9]{64})+$/i.test(inputs)||inputs.length!==2+count*64)throw new Error('Invalid proof public inputs');
 return {proof:value.proof,publicInputs:inputs};
}
export class TopicProofWorkflow {
 private readonly ai=new Map<string,AiTopicProofHandle>();private readonly now:()=>number;
 constructor(private readonly deps:WorkflowDeps){this.now=deps.now??Date.now;}
 private async request<T=any>(url:string,options?:any):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([this.deps.rest.request<T>(url,options),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Proof service request timed out; check status before retrying')),15000);})]);}finally{clearTimeout(timer);}
 }
 private fingerprint(){const token=this.deps.rest.getToken();if(!token)throw new Error('Proof operation requires an authenticated credential');return createHash('sha256').update(JSON.stringify([token,this.deps.rest.getApiKey?.()??null])).digest('hex');}
 private assertCredential(r:Operation){if(r.fingerprint!==this.fingerprint())throw new Error('Proof operation belongs to a different credential or server');}
 private stopAi(id:string){this.ai.get(id)?.cancel();this.ai.delete(id);}
 private async load(id:string){const r=await this.deps.store.read(id);if(r.version!==1||r.baseUrl!==this.deps.baseUrl||r.fingerprint!==this.fingerprint())throw new Error('Proof operation belongs to a different credential or server');
  if(!TERMINAL.has(r.state)&&r.expiresAt<=this.now()){this.stopAi(id);r.state='expired';await this.deps.store.write(r);}return r;}
 private view(r:Operation,extra:Partial<ProofWorkflowResult>={}):ProofWorkflowResult{
  const status=r.state==='submitting'?'failed':r.state;
  const result:ProofWorkflowResult={status,operationId:r.id,requirement:r.requirement,methods:['app','ai'],expiresAt:new Date(r.expiresAt).toISOString(),message:r.message??'Proof is required. Choose app or ai, then explicitly approve generation. AI service use may incur provider charges.',pollAfterMs:1500,...(r.method?{method:r.method}:{}),...(r.provider?{provider:r.provider}:{}),...(r.result!==undefined?{result:r.result}:{}),...extra};
  if(r.deepLink&&r.requestId){result.deepLink=r.deepLink;result.browserUrl=`${this.deps.baseUrl}/proof#${Buffer.from(JSON.stringify({requestId:r.requestId,deepLink:r.deepLink,scope:r.scope,circuitType:r.requirement.circuitType})).toString('base64url')}`;}
  return result;
 }
 async required(action:ProofAction,error:unknown):Promise<ProofWorkflowResult>{
  const e=error as {status?:number;body?:any};const body=e?.body;const raw=body?.proofRequirement;
  if(!((e?.status===402)||(e?.status===400&&body?.error==='Invalid or unverifiable topic proof'))||!raw||typeof body.proofScope!=='string'||!body.proofScope.startsWith('zkproofport-community:topic:'))throw error;
  if(!Object.hasOwn(CIRCUITS,raw.type)||raw.circuit!==CIRCUITS[raw.type])throw new Error('Unsupported proof requirement returned by server');
  const requirement:ProofRequirement={type:raw.type,circuitType:raw.circuit};
  if(raw.domain!=null){if(typeof raw.domain!=='string'||raw.domain.length>253)throw new Error('Invalid proof domain');requirement.domain=raw.domain;}
  if(raw.allowedCountries!=null){if(!Array.isArray(raw.allowedCountries)||!raw.allowedCountries.length||raw.allowedCountries.length>10||!raw.allowedCountries.every((v:unknown)=>typeof v==='string'&&/^[A-Z]{2}$/.test(v)))throw new Error('Invalid proof country requirement');requirement.allowedCountries=raw.allowedCountries;}
  const clean=structuredClone(action);if('input'in clean){delete clean.input.proof;delete clean.input.publicInputs;}
  const r:Operation={version:1,id:randomUUID(),action:clean,fingerprint:this.fingerprint(),baseUrl:this.deps.baseUrl,scope:body.proofScope,requirement,expiresAt:this.now()+TTL,state:'proof_required'};
  await this.deps.store.write(r);return this.view(r,raw.type==='workspace'?{requiredInputs:['provider (google or microsoft)']}:{});
 }
 async continue(input:ProofContinueInput):Promise<ProofWorkflowResult>{
  if(input.approved!==true)throw new Error('Explicit consent is required before generating a proof');
  if(input.method!=='app'&&input.method!=='ai')throw new Error('Unknown proof method');
  return this.deps.store.lock(input.operationId,async()=>{
   const r=await this.load(input.operationId);if(TERMINAL.has(r.state)||r.state==='submitting')return this.view(r);
   if(r.state==='pending'||r.state==='proof_ready')return this.view(r,{message:'This operation already has a proof request. Check status or cancel it first.'});
   const requiredProvider=r.requirement.type==='google_workspace'?'google':r.requirement.type==='microsoft_365'?'microsoft':undefined;
   const provider=input.provider??requiredProvider;
   if(provider&&provider!=='google'&&provider!=='microsoft')throw new Error('Unknown proof provider');
   if(requiredProvider&&provider!==requiredProvider)throw new Error('Provider does not match the topic requirement');
   if(r.requirement.type==='workspace'&&!provider)return this.view(r,{requiredInputs:['provider (google or microsoft)'],message:'Choose google or microsoft for this workspace proof.'});
   const challenge=await this.request<any>('/api/auth/challenge',{method:'POST'});
   if(challenge.scope!==r.scope)throw new Error('Authenticated proof scope changed; start the topic action again');
   this.assertCredential(r);
   r.method=input.method;r.provider=provider;
   if(input.method==='app'){
    const created=await this.request<any>('/api/auth/proof-request',{method:'POST',body:{mode:'proof',circuitType:r.requirement.circuitType,...(provider?{provider}:{}),...(r.requirement.domain?{domain:r.requirement.domain}:{}),...(r.requirement.allowedCountries?{countryList:r.requirement.allowedCountries,isIncluded:true}:{})}});
    if(created.scope!==r.scope||created.circuitType!==r.requirement.circuitType||typeof created.requestId!=='string'||!created.requestId||created.requestId.length>256||typeof created.deepLink!=='string'||!created.deepLink.startsWith('zkproofport://proof-request?'))throw new Error('Invalid app proof request response');
    r.requestId=created.requestId;r.deepLink=created.deepLink;r.state='pending';r.message='Open browserUrl and scan its QR code with ZKProofport, or open deepLink on your phone. Return here after approving the proof.';
   }else{
    try{const handle=(this.deps.startAi??startAiTopicProof)({proofType:r.requirement.type as any,scope:r.scope,countries:r.requirement.allowedCountries,provider,consent:true});this.ai.set(r.id,handle);r.state='pending';r.message='AI proof started. Check status for the device verification URL/code. Keep this CLI --wait or MCP process running.';}
    catch(error){const e=error as {requiredInputs?:string[];message?:string};return this.view(r,{status:'proof_required',requiredInputs:e.requiredInputs??[],message:e.message??'Cannot start AI proof; use app mode instead.'});}
   }
   try{await this.deps.store.write(r);}catch(error){this.stopAi(r.id);throw error;}return this.view(r);
  });
 }
 private async poll(r:Operation):Promise<{result:ProofWorkflowResult;proof?:{proof:string;publicInputs:string}}>{
  if(TERMINAL.has(r.state)||r.state==='proof_required'||r.state==='submitting')return {result:this.view(r)};
  if(r.method==='ai'){
   const handle=this.ai.get(r.id);
   if(!handle){r.state='proof_required';r.message='The AI proof process ended. Explicitly continue again, or choose app mode.';await this.deps.store.write(r);return {result:this.view(r)};}
   const status=handle.status();
   if(status.status==='completed'){r.state='proof_ready';return {result:this.view(r,{message:'Proof is ready. Resume to finish the original topic action.'}),proof:normalizedProof(await handle.wait(),r.requirement.circuitType)};}
   if(status.status==='failed'||status.status==='cancelled'){this.ai.delete(r.id);r.state=status.status;r.message=status.error??'AI proof cancelled or failed. Start a new topic action to retry.';await this.deps.store.write(r);return {result:this.view(r)};}
   return {result:this.view(r,{verificationUrl:status.verificationUrl,userCode:status.userCode,message:'Complete the device authorization if shown; proof generation is still pending.'})};
  }
  if(!r.requestId)throw new Error('Missing app proof request');
  let data:any;
  try{data=await this.request(`/api/auth/poll/${encodeURIComponent(r.requestId)}?mode=proof`);}catch(error){
   const status=(error as {status?:number}).status;
   if(status===404||status===410){r.state='expired';r.message='The app proof request expired. Start the topic action again.';await this.deps.store.write(r);return {result:this.view(r)};}
   if(status===400){r.state='failed';r.message='The app proof could not be verified. Start the topic action again.';await this.deps.store.write(r);return {result:this.view(r)};}
   throw error;
  }
  if(data.status==='completed'){
   if(data.circuit!==r.requirement.circuitType)throw new Error('Proof circuit does not match the operation');
   const expectedScope='0x'+Buffer.from(keccak_256(new TextEncoder().encode(r.scope))).toString('hex');
   if(typeof data.scopeHash!=='string'||data.scopeHash.toLowerCase()!==expectedScope)throw new Error('Verified proof scope does not match the operation');
   r.state='proof_ready';return {result:this.view(r,{message:'Proof is ready. Resume to finish the original topic action.'}),proof:normalizedProof(data,r.requirement.circuitType)};
  }
  if(['cancelled','expired','failed','error'].includes(data.status)){r.state=data.status==='error'?'failed':data.status;r.message=`App proof ${r.state}.`;await this.deps.store.write(r);return {result:this.view(r)};}
  if(data.status!=='pending'&&data.status!=='processing')throw new Error('Unknown app proof status');
  return {result:this.view(r)};
 }
 async status(id:string){return this.deps.store.lock(id,async()=>{const r=await this.load(id);return (await this.poll(r)).result;});}
 async resume(id:string){return this.deps.store.lock(id,async()=>{
  const r=await this.load(id);const polled=await this.poll(r);if(!polled.proof)return polled.result;
  const current=await this.load(id);if(current.state==='expired')return this.view(current);
  // Durable submission marker prevents duplicate creation after an ambiguous failure.
  r.state='submitting';r.message='The original action was submitted. Its outcome is uncertain; inspect your topics before starting another action.';await this.deps.store.write(r);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   // No await may separate this credential check from request dispatch.
   this.assertCredential(r);
   r.result=await Promise.race([this.deps.submit(r.action,polled.proof),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Submission outcome unknown')),this.deps.submitTimeoutMs??15000);})]);
   r.state='completed';r.message='Proof verified and the original topic action completed.';
  }
  catch{r.state='failed';r.message='The original action did not return success. Check membership/topics before retrying; it may have reached the server. The proof did not bypass server verification.';}
  finally{clearTimeout(timer);this.ai.delete(id);}
  await this.deps.store.write(r);return this.view(r);
 });}
 async cancel(id:string){return this.deps.store.lock(id,async()=>{const r=await this.load(id);if(TERMINAL.has(r.state)||r.state==='submitting')return this.view(r);this.stopAi(id);r.state='cancelled';r.message='Local continuation cancelled. No topic action will be submitted. Work already sent to an external prover cannot be recalled.';await this.deps.store.write(r);return this.view(r);});}
}
