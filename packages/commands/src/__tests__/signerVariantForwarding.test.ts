/**
 * signerVariant names the circuit package that made a topic proof; the server
 * picks the verifier by it. Edge matrix, on create / join / invite-join:
 * - app QR path: each known value from the proof-mode poll reaches the resumed
 *   request unchanged; absent stays absent; an unknown one throws naming it and
 *   the known ones, and nothing is resubmitted.
 * - raw path (--proof / proof args): same three outcomes, refused before any
 *   network call; a variant without a proof, or with generation options, is refused.
 * - a variant supplied with a refused raw proof is not kept in the saved action,
 *   so a later proof cannot inherit it.
 * Real Commands + ChatClient; the network is the fetch boundary.
 */
import {afterEach,expect,it,vi} from 'vitest';
import {ChatClient} from '@masselabs/openstoa';
import {Commands} from '../commands';
import {MemorySessionStore} from '../session';
import {MemoryProofOperationStore} from '../topicProofWorkflow';
afterEach(()=>vi.restoreAllMocks());
const scope='zkproofport-community:topic:alice';
const scopeHash='0x54397129f0b3b0e5c469a48458023d6386775b7f54c34ae43fb6b09fc47d4ecf';
const kinds=['create','join','invite'] as const;
const VARIANTS=['standard','android','android_factory'] as const;
const UNKNOWN:unknown[]=['ios','','ANDROID',' android','android\n','аndroid','__proto__','toString','android'.repeat(10),42,null,{},['android'],true];
const proof='0xaabb';
const publicInputs='0x'+'01'.padStart(64,'0').repeat(193);
function fixture(kind:typeof kinds[number],poll:Record<string,unknown>={}){
 const original=kind==='create'?'/api/topics':kind==='join'?'/api/topics/t1/join':'/api/topics/join/code';
 let businessStatus=402;
 const fetch=vi.fn(async(url:string|URL,_init?:RequestInit)=>{
  const path=new URL(url).pathname;
  if(path===original)return new Response(JSON.stringify(businessStatus===402?{proofScope:scope,proofRequirement:{type:'kyc',circuit:'coinbase_attestation'}}:{topic:{id:'created'},joined:true,topicId:'t1'}),{status:businessStatus});
  if(path==='/api/auth/challenge')return Response.json({scope});
  if(path==='/api/auth/proof-request')return Response.json({requestId:'request-1',deepLink:'zkproofport://proof-request?data=x',scope,circuitType:'coinbase_attestation'});
  if(path==='/api/auth/poll/request-1')return Response.json({status:'completed',circuit:'coinbase_attestation',scopeHash,proof,publicInputs:Array(193).fill('0x'+'01'.padStart(64,'0')),...poll});
  throw new Error('Unexpected test route '+path);
 });
 const chat=new ChatClient({baseUrl:'https://openstoa.test',token:'session-fixture',apiKey:'osk_fixture',fetch:fetch as typeof globalThis.fetch});
 const store=new MemoryProofOperationStore();
 const commands=new Commands({chat,baseUrl:'https://openstoa.test',session:null,sessionStore:new MemorySessionStore(),proofStore:store});
 const invoke=(options:Record<string,unknown>={})=>kind==='create'?commands.topicCreate({title:'제목 🔐',categoryId:'c1',proofType:'kyc',...options} as any):kind==='join'?commands.topicJoin('t1',options as any):commands.executeOperation('topic_join_invite',{inviteCode:'code',...options});
 const bodies=()=>fetch.mock.calls.filter(([url])=>new URL(url).pathname===original).map(([,init])=>JSON.parse(String(init?.body??'{}')));
 return {commands,store,fetch,invoke,bodies,succeed(){businessStatus=201;}};
}
/** Ask for the action, approve the app QR path, let the phone finish, and resume. */
async function throughApp(h:ReturnType<typeof fixture>){
 const pending=await h.invoke({approved:true,method:'app'}) as any;
 expect(pending.status).toBe('pending');
 h.succeed();
 return h.commands.proofResume(pending.operationId);
}

for(const kind of kinds){
 it.each(VARIANTS)(`${kind}: the app proof's signerVariant %s reaches the resumed request unchanged`,async signerVariant=>{
  const h=fixture(kind,{signerVariant});
  expect((await throughApp(h)).status).toBe('completed');
  expect(h.bodies()).toHaveLength(2);
  expect(h.bodies()[1]).toMatchObject({proof,publicInputs,signerVariant});
 });
 it(`${kind}: an app proof without signerVariant is resubmitted without one`,async()=>{
  const h=fixture(kind);
  expect((await throughApp(h)).status).toBe('completed');
  expect(h.bodies()[1]).toMatchObject({proof,publicInputs});
  expect(Object.keys(h.bodies()[1])).not.toContain('signerVariant');
 });
 it.each(UNKNOWN.filter(value=>value!==undefined))(`${kind}: an app proof whose signerVariant is %j is refused by name and never resubmitted`,async signerVariant=>{
  const h=fixture(kind,{signerVariant});
  const pending=await h.invoke({approved:true,method:'app'}) as any;h.succeed();
  await expect(h.commands.proofResume(pending.operationId)).rejects.toThrow(/Unknown signerVariant .*Known: standard, android, android_factory\./);
  expect(h.bodies()).toHaveLength(1);
 });
 it.each(VARIANTS)(`${kind}: a supplied proof's signerVariant %s is sent unchanged`,async signerVariant=>{
  const h=fixture(kind);h.succeed();
  await h.invoke({proof,publicInputs,signerVariant});
  expect(h.bodies()).toEqual([expect.objectContaining({proof,publicInputs,signerVariant})]);
 });
 it(`${kind}: a supplied proof without signerVariant is sent without one, even as an undefined key`,async()=>{
  const h=fixture(kind);h.succeed();
  await h.invoke({proof,publicInputs,signerVariant:undefined});
  expect(h.bodies()).toHaveLength(1);
  expect(Object.keys(h.bodies()[0])).not.toContain('signerVariant');
 });
 it.each(UNKNOWN)(`${kind}: a supplied signerVariant %j is refused before any request`,async signerVariant=>{
  const h=fixture(kind);h.succeed();
  await expect(h.invoke({proof,publicInputs,signerVariant})).rejects.toThrow(/signerVariant.*(standard, android, android_factory)/);
  expect(h.fetch).not.toHaveBeenCalled();
 });
 it(`${kind}: a signerVariant without a proof, or with generation options, is refused before any request`,async()=>{
  const h=fixture(kind);
  await expect(h.invoke({signerVariant:'android'})).rejects.toThrow(/only sent with proof/);
  await expect(h.invoke({signerVariant:'android',approved:true,method:'app'})).rejects.toThrow(/Cannot combine/);
  expect(h.fetch).not.toHaveBeenCalled();
 });
 it(`${kind}: a refused supplied proof's signerVariant is not inherited by the next proof`,async()=>{
  const h=fixture(kind);
  const required=await h.invoke({proof,publicInputs,signerVariant:'android_factory'}) as any;
  expect(required.status).toBe('proof_required');
  const saved=(await h.store.read(required.operationId)).action;
  expect('input' in saved?saved.input:saved).not.toHaveProperty('signerVariant');
  expect((await h.commands.proofContinue({operationId:required.operationId,method:'app',approved:true})).status).toBe('pending');
  h.succeed();
  expect((await h.commands.proofResume(required.operationId)).status).toBe('completed');
  expect(Object.keys(h.bodies().at(-1)!)).not.toContain('signerVariant');
 });
}
