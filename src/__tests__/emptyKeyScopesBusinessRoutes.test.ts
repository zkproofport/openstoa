/** A selected key with no capabilities cannot borrow its owner's route privileges. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({session:{userId:'alice',isAI:true,apiKeyId:'narrow-key',apiKeyCmd:[] as string[]},insert:vi.fn(),update:vi.fn(),upload:vi.fn(),strip:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:async()=>mocks.session}));
vi.mock('@/lib/db',()=>({db:{query:{topicMembers:{findFirst:async()=>({role:'owner'})},topics:{findFirst:async()=>({id:'topic',visibility:'public',proofType:'none'})},categories:{findFirst:async()=>({id:'category',name:'General',slug:'general'})}},insert:mocks.insert,update:mocks.update}}));
vi.mock('@/lib/r2',()=>({uploadToR2:mocks.upload,deleteFromR2ByUrl:vi.fn(),deleteOrphanedR2Urls:vi.fn(),isMissingR2ConfigError:()=>false}));
vi.mock('@/lib/imageMetadata',()=>({stripImageMetadata:mocks.strip,ImageMetadataError:class extends Error{}}));
vi.mock('@/lib/sharpModule',()=>({loadSharp:vi.fn(()=>{throw new Error('Image processing should not run without scope');})}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
vi.mock('@/lib/redis',()=>({redis:{get:vi.fn(),set:vi.fn()},getRedis:()=>({incr:async()=>1,expire:async()=>1})}));
import {POST as createTopic} from '@/app/api/topics/route';
import {POST as joinTopic} from '@/app/api/topics/[topicId]/join/route';
import {GET as readPosts,POST as writePost} from '@/app/api/topics/[topicId]/posts/route';
import {GET as readPost} from '@/app/api/posts/[postId]/route';
import {PUT as nickname} from '@/app/api/profile/nickname/route';
import {PUT as avatar} from '@/app/api/profile/image/route';
import {POST as upload} from '@/app/api/upload/route';
const id='12345678-1234-4234-8234-123456789abc';
const ctx={params:Promise.resolve({topicId:id})};
function req(path:string,method='POST',body:unknown={}){return new NextRequest('http://localhost:3200'+path,{method,headers:{authorization:'Bearer test-session','X-OpenStoa-API-Key':'osk_test-only',...(method==='GET'?{}:{'content-type':'application/json'})},...(method==='GET'?{}:{body:JSON.stringify(body)})});}
async function uploadImage(purpose='post',topicId?:string){const form=new FormData();form.set('file',new File([new Uint8Array([137,80,78,71])],'image.png',{type:'image/png'}));form.set('purpose',purpose);if(topicId)form.set('topicId',topicId);return upload(new NextRequest('http://localhost:3200/api/upload',{method:'POST',headers:{authorization:'Bearer test-session','X-OpenStoa-API-Key':'osk_test-only'},body:form}));}
const cases:[string,()=>Promise<Response>][]=[
 ['topic creation',()=>createTopic(req('/api/topics','POST',{title:'Scoped topic',proofType:'none',categoryId:'category'}))],
 ['topic joining',()=>joinTopic(req('/api/topics/'+id+'/join'),ctx)],
 ['post listing',()=>readPosts(req('/api/topics/'+id+'/posts','GET'),ctx)],
 ['post detail',()=>readPost(req('/api/posts/'+id,'GET'),{params:Promise.resolve({postId:id})})],
 ['post writing',()=>writePost(req('/api/topics/'+id+'/posts','POST',{title:'Post',content:'content'}),ctx)],
 ['nickname editing',()=>nickname(req('/api/profile/nickname','PUT',{nickname:'changed'}))],
 ['avatar editing',()=>avatar(req('/api/profile/image','PUT',{imageUrl:'https://cdn.example/avatar.png'}))],
 ['image upload',()=>uploadImage()],
];
beforeEach(()=>{vi.clearAllMocks();mocks.session={userId:'alice',isAI:true,apiKeyId:'narrow-key',apiKeyCmd:[]};});
describe.each([true,false])('selected empty key (isAI=%s)',isAI=>{
 it.each(cases)('refuses %s using capability denial, before any mutation',async(_name,call)=>{
  mocks.session.isAI=isAI;const response=await call();expect(response.status).toBe(403);expect((await response.json()).error).toMatch(/capability|scope|permitted/i);expect(mocks.insert).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.strip).not.toHaveBeenCalled();
 });
});

const destinations:[string,string,string|undefined][]=[['post','/openstoa/post/write',undefined],['avatar','/openstoa/profile/edit',undefined],['topic','/openstoa/topic/create',undefined],['topic','/openstoa/topic/edit',id]];
describe.each([true,false])('upload destination scope (isAI=%s)',isAI=>{
 it.each(destinations)('%s requires upload/write plus destination capability %s',async(purpose,capability,topicId)=>{
  mocks.session.isAI=isAI;
  for(const incomplete of [['/openstoa/upload/write'],[capability]]){
   mocks.session.apiKeyCmd=incomplete;const response=await uploadImage(purpose,topicId);expect(response.status).toBe(403);expect(mocks.strip).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled();
  }
  mocks.session.apiKeyCmd=['/openstoa/upload/write',capability];mocks.strip.mockResolvedValue({buffer:Buffer.from('sanitized'),format:'png',strategy:'test'});mocks.upload.mockResolvedValue('https://cdn.example/test.png');
  const response=await uploadImage(purpose,topicId);expect(response.status).toBe(200);expect(mocks.strip).toHaveBeenCalledOnce();expect(mocks.upload).toHaveBeenCalledOnce();
 });
});

describe.each([true,false])('post detail includes comments (isAI=%s)',isAI=>{
 it.each(['/openstoa/post/read','/openstoa/comment/read'])('refuses incomplete %s grant before reading the combined resource',async scope=>{
  mocks.session.isAI=isAI;mocks.session.apiKeyCmd=[scope];
  const response=await readPost(req('/api/posts/'+id,'GET'),{params:Promise.resolve({postId:id})});expect(response.status).toBe(403);expect((await response.json()).code).toBe('api_scope_denied');
 });
});
