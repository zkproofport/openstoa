/**
 * Edge matrix: every circuit/provider and country bounds; explicit consent;
 * missing/env-only keys; chunked provider prompts; malformed/large output;
 * safe failures; timeout/cancel/process exit; no duplicate automatic attempt.
 * The subprocess is controlled here: no real prover, OAuth login, or charge.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAiTopicProverPath, spawnAiTopicProver, startAiTopicProof } from '../aiTopicProof';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const scope = 'zkproofport-community:topic:alice';
function harness() {
 const child = Object.assign(new EventEmitter(), { stdout:new EventEmitter(), stderr:new EventEmitter(), kill:vi.fn() });
 const spawn = vi.fn((_args: string[], _env: NodeJS.ProcessEnv)=>child);
 const terminate = vi.fn();
 const deps = {spawn,terminate,env:{ATTESTATION_KEY:'test-key-only',PROOFPORT_URL:'http://localhost:4002',OPENSTOA_API_KEY:'never-forward'}};
 return {child,spawn,terminate,deps};
}
function complete(child:ReturnType<typeof harness>['child'], count=128, extra={}) {
 child.stdout.emit('data',JSON.stringify({proof:'0xab',publicInputs:Array(count).fill('0x'+'00'.repeat(32)),...extra}));
 child.emit('close',0);
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('AI topic proof adapter',()=>{
 it('resolves the installed published prover without executing it',()=>{
  expect(resolveAiTopicProverPath()).toMatch(/@zkproofport-ai\/mcp\/dist\/prove\.js$/);
 });
 it('starts Node directly with isolated piped output and no shell',()=>{
  const h=harness();vi.mocked(nodeSpawn).mockReturnValue(h.child as never);
  spawnAiTopicProver(['coinbase_kyc','--scope',scope],{PATH:'/test/bin'});
  expect(nodeSpawn).toHaveBeenCalledWith(process.execPath,[resolveAiTopicProverPath(),'coinbase_kyc','--scope',scope],{
   env:{PATH:'/test/bin'},stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform !== 'win32',
  });
 });
 it.each(['exit','SIGINT','SIGTERM'] as const)('cleans only active adapter children on %s and releases lifecycle hooks',async(event)=>{
  const existing=new Set((process as EventEmitter).listeners(event));const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);
  const hook=(process as EventEmitter).listeners(event).find(listener=>!existing.has(listener));expect(hook).toBeTypeOf('function');
  const kill=vi.spyOn(process,'kill').mockReturnValue(true);
  (hook as (...args:unknown[])=>void)(0);
  await expect(handle.wait()).rejects.toMatchObject({code:'cancelled'});expect(h.terminate).toHaveBeenCalledOnce();
  expect((process as EventEmitter).listeners(event)).not.toContain(hook);
  if(event==='exit')expect(kill).not.toHaveBeenCalled();
 });
 it('removes exit and signal listeners when the last proof completes',async()=>{
  const before=['exit','SIGINT','SIGTERM'].map(event=>process.listenerCount(event));const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);complete(h.child);await handle.wait();
  expect(['exit','SIGINT','SIGTERM'].map(event=>process.listenerCount(event))).toEqual(before);
 });
 it.each([
  ['User denied the authorization request','authorization_denied'],
  ['Device code expired. Please try again.','authorization_expired'],
  ['Device code flow timed out after 5 minutes','authorization_expired'],
  ['Payment required: 402 secret','payment_required'],
  ['fetch failed: private server address','prover_unavailable'],
 ])('maps installed prover failure %s without leaking raw details',async(message,code)=>{
  const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},h.deps);
  h.child.stderr.emit('data',JSON.stringify({error:message,token:'hidden-token'})+'\n');h.child.emit('close',1);
  await expect(handle.wait()).rejects.toMatchObject({code});
  expect(JSON.stringify(handle.status())).not.toContain('hidden-token');
 });
 it.each([
  [{proofType:'kyc'},['coinbase_kyc']],
  [{proofType:'country',countries:['kr','US']},['coinbase_country','--countries','KR,US','--included','true']],
  [{proofType:'google_workspace'},['--login-google-workspace']],
  [{proofType:'microsoft_365'},['--login-microsoft-365']],
  [{proofType:'workspace',provider:'google'},['--login-google-workspace']],
  [{proofType:'workspace',provider:'microsoft'},['--login-microsoft-365']],
 ] as const)('selects explicit prover arguments for %j',(input,expected)=>{
  const h=harness();const handle=startAiTopicProof({...input,scope,consent:true} as never,h.deps);
  expect(h.spawn).toHaveBeenCalledWith([...expected,'--scope',scope,'--silent'],expect.objectContaining({ZKPROOFPORT_SILENT:'1'}));
  expect(h.spawn.mock.calls[0][1]).not.toHaveProperty('OPENSTOA_API_KEY');
  if (input.proofType === 'kyc' || input.proofType === 'country') expect(h.spawn.mock.calls[0][1]).toHaveProperty('ATTESTATION_KEY','test-key-only');
  else expect(h.spawn.mock.calls[0][1]).not.toHaveProperty('ATTESTATION_KEY');
  handle.cancel();
 });
 it('never starts before explicit consent',()=>{const h=harness();expect(()=>startAiTopicProof({proofType:'kyc',scope,consent:false} as never,h.deps)).toThrow(/consent/i);expect(h.spawn).not.toHaveBeenCalled();});
 it('requires Coinbase key in the environment without exposing it as an argument',()=>{const h=harness();expect(()=>startAiTopicProof({proofType:'kyc',scope,consent:true},{...h.deps,env:{}})).toThrow(/ATTESTATION_KEY/);expect(h.spawn).not.toHaveBeenCalled();});
 it('workspace requires no attestation wallet',()=>{const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},{...h.deps,env:{}});expect(h.spawn).toHaveBeenCalledOnce();handle.cancel();});
 it.each([{proofType:'unknown'}, {proofType:'__proto__'}, {proofType:'workspace'}, {proofType:'country',countries:[]}, {proofType:'country',countries:['USA']}, {proofType:'country',countries:Array(11).fill('KR')}, {proofType:'google_workspace',provider:'microsoft'}, {proofType:'kyc',scope:''}, {proofType:'kyc',scope:'x'.repeat(513)}])('refuses invalid or ambiguous input %j',input=>{const h=harness();expect(()=>startAiTopicProof({scope,consent:true,...input} as never,h.deps)).toThrow();expect(h.spawn).not.toHaveBeenCalled();});
 it('surfaces a chunked Google device prompt promptly and discards unrelated stderr',()=>{const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},h.deps);h.child.stderr.emit('data','secret jwt-value\n  Op');h.child.stderr.emit('data','en: https://www.google.com/device\n  Co');h.child.stderr.emit('data','de: ABCD-EFGH\n');expect(handle.status()).toEqual({status:'awaiting_authorization',verificationUrl:'https://www.google.com/device',userCode:'ABCD-EFGH'});expect(JSON.stringify(handle.status())).not.toContain('jwt-value');handle.cancel();});
 it('accepts the published Microsoft device URL',()=>{const h=harness();const handle=startAiTopicProof({proofType:'microsoft_365',scope,consent:true},h.deps);h.child.stderr.emit('data','Open: https://microsoft.com/devicelogin\nCode: 12345678\n');expect(handle.status().status).toBe('awaiting_authorization');handle.cancel();});
 it('rejects a provider prompt pointing at another host',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},h.deps);h.child.stderr.emit('data','Open: https://attacker.invalid/device\nCode: ABCD\n');await expect(handle.wait()).rejects.toThrow(/device|provider/i);expect(h.terminate).toHaveBeenCalledOnce();});
 it('normalizes returned arrays, exposes no proof in snapshots, and strips extra fields',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);complete(h.child,128,{jwt:'secret-token',privateKey:'secret-key'});expect(await handle.wait()).toEqual({proof:'0xab',publicInputs:'0x'+'00'.repeat(32*128)});expect(handle.status()).toEqual({status:'completed'});});
 it('waits for close so trailing stdout after exit is not dropped',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);h.child.emit('exit',0);expect(handle.status().status).not.toBe('completed');complete(h.child);await expect(handle.wait()).resolves.toHaveProperty('proof','0xab');});
 it.each(['not json',JSON.stringify({proof:'secret'}),JSON.stringify({proof:'0xab',publicInputs:['0x00']})])('fails closed on malformed output without echoing it',async(output)=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);h.child.stdout.emit('data',output);h.child.emit('close',0);await expect(handle.wait()).rejects.toThrow(/proof|output/i);expect(JSON.stringify(handle.status())).not.toContain('secret');});
 it.each(['stdout','stderr'] as const)('terminates oversized %s without retaining output',async(stream)=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);h.child[stream].emit('data','SENSITIVE'.repeat(40000));await expect(handle.wait()).rejects.toThrow(/limit/i);expect(h.terminate).toHaveBeenCalledOnce();expect(JSON.stringify(handle.status())).not.toContain('SENSITIVE');});
 it('reports a fixed OAuth configuration error without raw token text',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},h.deps);h.child.stderr.emit('data','{"error":"deleted_client","token":"secret-token"}\n');h.child.emit('close',1);await expect(handle.wait()).rejects.toThrow(/OAuth client/i);expect(JSON.stringify(handle.status())).not.toContain('secret-token');expect(h.spawn).toHaveBeenCalledOnce();});
 it('handles process errors without exposing environment or OS text',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);h.child.emit('error',new Error('private env secret'));await expect(handle.wait()).rejects.toThrow(/start|process/i);expect(JSON.stringify(handle.status())).not.toContain('secret');});
 it('cancels once and ignores late completion',async()=>{const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},h.deps);handle.cancel();handle.cancel();complete(h.child);await expect(handle.wait()).rejects.toThrow(/cancel/i);expect(handle.status()).toEqual({status:'cancelled'});expect(h.terminate).toHaveBeenCalledOnce();});
 it('enforces the overall timeout without automatically retrying',async()=>{vi.useFakeTimers();const h=harness();const handle=startAiTopicProof({proofType:'kyc',scope,consent:true},{...h.deps,timeoutMs:50});await vi.advanceTimersByTimeAsync(51);await expect(handle.wait()).rejects.toThrow(/timed out/i);expect(h.spawn).toHaveBeenCalledOnce();expect(h.terminate).toHaveBeenCalledOnce();});
 it('bounds the wait for an OAuth device prompt',async()=>{vi.useFakeTimers();const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},{...h.deps,deviceTimeoutMs:25});await vi.advanceTimersByTimeAsync(26);await expect(handle.wait()).rejects.toThrow(/device|timed out/i);expect(h.terminate).toHaveBeenCalledOnce();});
});

describe('AI Google login adapter contract',()=>{
 it('selects generic --login-google with community scope and no attestation wallet',()=>{
  const h=harness();const handle=startAiTopicProof({proofType:'google_login',scope:'zkproofport-community',consent:true},h.deps);
  expect(h.spawn).toHaveBeenCalledWith(['--login-google','--scope','zkproofport-community','--silent'],expect.any(Object));expect(h.spawn.mock.calls[0][1]).not.toHaveProperty('ATTESTATION_KEY');expect(handle.status().status).toBe('starting');handle.cancel();
 });
 it.each(['zkproofport-community:topic:alice','other-scope',''])('refuses non-login scope %s before spawning',scope=>{
  const h=harness();expect(()=>startAiTopicProof({proofType:'google_login',scope,consent:true},h.deps)).toThrow();expect(h.spawn).not.toHaveBeenCalled();
 });
 it('refuses a conflicting Microsoft provider for Google-only login',()=>{
  const h=harness();let handle:ReturnType<typeof startAiTopicProof>|undefined;
  try{expect(()=>{handle=startAiTopicProof({proofType:'google_login',scope:'zkproofport-community',provider:'microsoft',consent:true},h.deps);}).toThrow();expect(h.spawn).not.toHaveBeenCalled();}finally{handle?.cancel();}
 });
 it('preserves only required login verification/payment/TEE metadata for server verification',async()=>{
  const h=harness();const handle=startAiTopicProof({proofType:'google_login',scope:'zkproofport-community',consent:true},h.deps);
  const metadata={verification:{chainId:8453,verifierAddress:'0x1234'},paymentTxHash:'0x'+'ab'.repeat(32),attestation:{document:'test-attestation'}};
  complete(h.child,148,{...metadata,jwt:'private-jwt',privateKey:'private-key',circuit:'coinbase_attestation',proofType:'kyc'});
  const result=await handle.wait();expect(result.loginResult).toEqual({proof:'0xab',publicInputs:result.publicInputs,proofType:'google_login',...metadata});expect(JSON.stringify(result)).not.toContain('private-jwt');expect(JSON.stringify(result)).not.toContain('private-key');expect(handle.status()).toEqual({status:'completed'});
 });
 it('never carries login-only metadata into topic proof results',async()=>{
  const h=harness();const handle=startAiTopicProof({proofType:'google_workspace',scope,consent:true},h.deps);complete(h.child,148,{verification:{chainId:8453},paymentTxHash:'payment',attestation:{document:'tee'}});
  expect(await handle.wait()).toEqual({proof:'0xab',publicInputs:'0x'+'00'.repeat(148*32)});
 });
});
