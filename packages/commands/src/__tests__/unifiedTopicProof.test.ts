import {afterEach,expect,it,vi} from 'vitest';
import {ChatClient} from '@masselabs/openstoa';
import {Commands} from '../commands';
import {MemorySessionStore} from '../session';
import {MemoryProofOperationStore,TopicProofWorkflow} from '../topicProofWorkflow';
afterEach(()=>vi.restoreAllMocks());
const scope='zkproofport-community:topic:alice';
const proofRequired={proofScope:scope,proofRequirement:{type:'kyc',circuit:'coinbase_attestation'}};
const kinds=['create','join','invite'] as const;
function fixture(kind:typeof kinds[number],status=402){
 const original=kind==='create'?'/api/topics':kind==='join'?'/api/topics/t1/join':'/api/topics/join/code';
 let businessStatus=status;
 const fetch=vi.fn(async(url:string|URL,init?:RequestInit)=>{
  const path=new URL(url).pathname;
  if(path===original)return new Response(JSON.stringify(businessStatus===402?proofRequired:businessStatus>=400?{error:'not allowed'}:{topic:{id:'created'},joined:true,topicId:'t1'}),{status:businessStatus});
  if(path==='/api/auth/challenge')return Response.json({scope});
  if(path==='/api/auth/proof-request')return Response.json({requestId:'request-1',deepLink:'zkproofport://proof-request?data=x',scope,circuitType:'coinbase_attestation'});
  if(path==='/api/auth/poll/request-1')return Response.json({status:'completed',circuit:'coinbase_attestation',scopeHash:'0x54397129f0b3b0e5c469a48458023d6386775b7f54c34ae43fb6b09fc47d4ecf',proof:'0xaabb',publicInputs:Array(128).fill('0x'+'01'.padStart(64,'0'))});
  throw new Error('Unexpected test route '+path);
 });
 const chat=new ChatClient({baseUrl:'https://openstoa.test',token:'session-fixture',apiKey:'osk_fixture',fetch:fetch as typeof globalThis.fetch});
 const store=new MemoryProofOperationStore();
 const commands=new Commands({chat,baseUrl:'https://openstoa.test',session:null,sessionStore:new MemorySessionStore(),proofStore:store});
 const continueSpy=vi.spyOn(TopicProofWorkflow.prototype,'continue');
 const invoke=(options:Record<string,unknown>={})=>kind==='create'?commands.topicCreate({title:'제목 🔐',categoryId:'c1',proofType:'kyc',...options} as any):kind==='join'?commands.topicJoin('t1',options as any):commands.executeOperation('topic_join_invite',{inviteCode:'code',...options});
 const mutations=()=>fetch.mock.calls.filter(([url])=>new URL(url).pathname===original);
 return {commands,store,fetch,continueSpy,invoke,mutations,succeed(){businessStatus=201;}};
}
it.each(kinds)('%s approval starts one app continuation and strips generation fields from HTTP and saved action',async kind=>{
 const h=fixture(kind);const result=await h.invoke({approved:true,method:'app',provider:'google'}) as any;
 expect(result.status).toBe('pending');expect(result.browserUrl).toContain('/proof#');
 expect(h.continueSpy).toHaveBeenCalledOnce();expect(h.continueSpy).toHaveBeenCalledWith(expect.objectContaining({approved:true,method:'app',provider:'google'}));
 expect(h.mutations()).toHaveLength(1);
 const body=JSON.parse(String(h.mutations()[0][1]?.body));const saved=(await h.store.read(result.operationId)).action;
 for(const key of ['approved','method','provider']){expect(body).not.toHaveProperty(key);expect('input' in saved?saved.input:saved).not.toHaveProperty(key);}
});
it.each(kinds)('%s explicit approval defaults to app',async kind=>{
 const h=fixture(kind);expect((await h.invoke({approved:true}) as any).status).toBe('pending');
 expect(h.continueSpy).toHaveBeenCalledWith(expect.objectContaining({method:'app',approved:true}));
});
it.each(kinds)('%s AI options delegate once to the existing continuation without leaking into the action',async kind=>{
 const h=fixture(kind);
 h.continueSpy.mockImplementation(async input=>({status:'pending',operationId:input.operationId,method:'ai',provider:input.provider,requirement:{type:'kyc',circuitType:'coinbase_attestation'},methods:['app','ai'],expiresAt:'2099-01-01T00:00:00Z',message:'Local prover test boundary',pollAfterMs:1}));
 const result=await h.invoke({method:'ai',approved:true,provider:'microsoft'}) as any;
 expect(result).toMatchObject({status:'pending',method:'ai'});expect(h.continueSpy).toHaveBeenCalledExactlyOnceWith({operationId:result.operationId,method:'ai',approved:true,provider:'microsoft'});
 expect(h.fetch).toHaveBeenCalledOnce();
 const saved=(await h.store.read(result.operationId)).action;
 for(const key of ['method','approved','provider'])expect('input' in saved?saved.input:saved).not.toHaveProperty(key);
});
it.each(kinds)('%s method/provider without approval does not start proving',async kind=>{
 const h=fixture(kind);const result=await h.invoke({method:'app',provider:'google',approved:false}) as any;
 expect(result.status).toBe('proof_required');expect(h.continueSpy).not.toHaveBeenCalled();
 expect(h.fetch).toHaveBeenCalledOnce();
 const saved=(await h.store.read(result.operationId)).action;
 expect('input' in saved?saved.input:saved).not.toHaveProperty('approved');
});
it.each(kinds)('%s without generation options preserves proof-required behavior',async kind=>{
 const h=fixture(kind);expect((await h.invoke() as any).status).toBe('proof_required');
 expect(h.fetch).toHaveBeenCalledOnce();expect(h.continueSpy).not.toHaveBeenCalled();
});
it.each(kinds)('%s raw proof remains supported when no generation controls are supplied',async kind=>{
 const h=fixture(kind,201);await h.invoke({proof:'0xaa',publicInputs:'0xbb'});
 expect(h.fetch).toHaveBeenCalledOnce();expect(h.continueSpy).not.toHaveBeenCalled();
 expect(JSON.parse(String(h.mutations()[0][1]?.body))).toMatchObject({proof:'0xaa',publicInputs:'0xbb'});
});
it.each(kinds)('%s approved continuation resumes the saved action exactly once',async kind=>{
 const h=fixture(kind);const result=await h.invoke({approved:true}) as any;
 expect(result.status).toBe('pending');h.succeed();
 expect((await h.commands.proofResume(result.operationId)).status).toBe('completed');
 expect((await h.commands.proofResume(result.operationId)).status).toBe('completed');
 expect(h.mutations()).toHaveLength(2);
 const body=JSON.parse(String(h.mutations()[1][1]?.body));expect(body.proof).toBe('0xaabb');
 for(const key of ['approved','method','provider'])expect(body).not.toHaveProperty(key);
});
it.each(kinds)('%s ungated or cached success never starts proving despite approved options',async kind=>{
 const h=fixture(kind,201);await h.invoke({approved:true,method:'app'});
 expect(h.fetch).toHaveBeenCalledOnce();expect(h.continueSpy).not.toHaveBeenCalled();
});
it.each(kinds.flatMap(kind=>[401,403].map(status=>({kind,status}))))('$kind HTTP $status never starts proving',async({kind,status})=>{
 const h=fixture(kind,status);await expect(h.invoke({approved:true,method:'app'})).rejects.toMatchObject({status});
 expect(h.fetch).toHaveBeenCalledOnce();expect(h.continueSpy).not.toHaveBeenCalled();
});
it.each(kinds.flatMap(kind=>[
 {method:'other'},{provider:'other'},{approved:'true'},{method:null},{provider:null},{approved:null},
 {proof:'0xaa',publicInputs:'0xbb',approved:true},{proof:'0xaa',publicInputs:'0xbb',method:'app'},
 {proof:'0xaa',publicInputs:'0xbb',approved:false},
].map(options=>({kind,options}))))('$kind rejects invalid or mixed proof inputs before any request: $options',async({kind,options})=>{
 const h=fixture(kind);await expect(h.invoke(options)).rejects.toThrow();
 expect(h.fetch).not.toHaveBeenCalled();expect(h.continueSpy).not.toHaveBeenCalled();
});
