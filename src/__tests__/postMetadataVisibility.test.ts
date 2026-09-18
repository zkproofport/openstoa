/** Guest metadata follows the same topic visibility as its parent post. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({session:null as null|{userId:string;isAI?:boolean},visibility:'public',member:false,postExists:true,topicExists:true,metadata:vi.fn(),postRead:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:async()=>mocks.session,getAuthenticatedSession:async()=>mocks.session}));
vi.mock('@/lib/db',async()=>{
 const {posts}=await import('@/lib/db/schema');
 const post=()=>mocks.postExists?{id:'12345678-1234-4234-8234-123456789abc',topicId:'12345678-1234-4234-8234-123456789def',content:'public or private content'}:undefined;
 return {db:{query:{posts:{findFirst:async()=>{mocks.postRead();return post();}},topics:{findFirst:async()=>mocks.topicExists?{visibility:mocks.visibility}:undefined},topicMembers:{findFirst:async()=>mocks.member?{userId:'alice'}:undefined}},select:()=>{
  let postQuery=false;const chain:any={from:(table:unknown)=>{postQuery=table===posts;if(postQuery)mocks.postRead();else mocks.metadata();return chain;},where:()=>chain,leftJoin:()=>chain,limit:async()=>post()?[post()]:[],orderBy:async()=>[],groupBy:async()=>[]};return chain;
 }}};
});
vi.mock('@/lib/identity-badges',()=>({withPublicIdentityBadges:async(rows:unknown[])=>rows}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import {canReadPost,canActOnPost} from '@/lib/postReadable';
import {GET as getRecords} from '@/app/api/posts/[postId]/records/route';
import {GET as getReactions} from '@/app/api/posts/[postId]/reactions/route';
const postId='12345678-1234-4234-8234-123456789abc';
const topicId='12345678-1234-4234-8234-123456789def';
const cases:[string,string,boolean,boolean,boolean][]=[
 ['public guest','public',false,false,true],
 ['private guest','private',false,false,false],
 ['secret guest','secret',false,false,false],
 ['public signed-in outsider','public',true,false,true],
 ['private signed-in outsider','private',true,false,true],
 ['secret signed-in outsider','secret',true,false,false],
 ['secret member','secret',true,true,true],
 ['unknown visibility outsider','future',true,false,false],
];
beforeEach(()=>{vi.clearAllMocks();mocks.session=null;mocks.visibility='public';mocks.member=false;mocks.postExists=true;mocks.topicExists=true;});
describe('shared read visibility',()=>{
 it.each(cases)('%s',async(_name,visibility,signedIn,member,allowed)=>{
  mocks.visibility=visibility;mocks.member=member;
  expect(await canReadPost(topicId,signedIn?'alice':undefined)).toBe(allowed);
  if(signedIn)expect(await canActOnPost(topicId,'alice')).toBe(allowed);
 });
 it('missing topic fails closed for guests and signed-in callers',async()=>{
  mocks.topicExists=false;expect(await canReadPost(topicId)).toBe(false);expect(await canReadPost(topicId,'alice')).toBe(false);
 });
});
const routes=[['records',getRecords],['reactions',getReactions]] as const;
describe.each(routes)('%s GET applies visibility before metadata reads',(name,handler)=>{
 it.each(cases)('%s',async(_label,visibility,signedIn,member,allowed)=>{
  mocks.visibility=visibility;mocks.member=member;mocks.session=signedIn?{userId:'alice',isAI:false}:null;
  const response=await handler(new NextRequest(`http://localhost/api/posts/${postId}/${name}`),{params:Promise.resolve({postId})});
  expect(response.status).toBe(allowed?200:signedIn?403:401);
  if(allowed)expect(mocks.metadata).toHaveBeenCalledOnce();else expect(mocks.metadata).not.toHaveBeenCalled();
 });
 it('preserves the existing missing-post response without reading metadata',async()=>{
  mocks.postExists=false;const response=await handler(new NextRequest(`http://localhost/api/posts/${postId}/${name}`),{params:Promise.resolve({postId})});
  expect(response.status).toBe(name==='records'?404:200);if(name==='reactions')expect(await response.json()).toEqual({reactions:[]});expect(mocks.metadata).not.toHaveBeenCalled();
 });
});
