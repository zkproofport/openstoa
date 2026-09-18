import {beforeEach, describe, expect, it, vi} from 'vitest';
import {NextRequest} from 'next/server';
const state=vi.hoisted(()=>({session:vi.fn(),rows:[] as unknown[][],redis:new Map<string,string>(),mget:vi.fn(),member:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('@/lib/redis',()=>({redis:{mget:state.mget,set:vi.fn(),get:async(k:string)=>state.redis.get(k)??null}}));
vi.mock('@/lib/db',()=>({db:{update:()=>({set:()=>({where:async()=>{}})}),query:{topicMembers:{findFirst:state.member}},select:()=>{
  const chain:Record<string,unknown>={};
  for(const method of ['from','innerJoin','leftJoin','where','orderBy','limit','offset']) chain[method]=()=>chain;
  chain.then=(resolve:(value:unknown)=>void)=>resolve(state.rows.shift()??[]);
  return chain;
}}}));
vi.mock('@/lib/reactions',()=>({attachReactionsToPosts:async(rows:unknown[])=>rows}));
vi.mock('@/lib/userPostFlags',()=>({attachUserFlagsToPosts:async(rows:unknown[])=>rows}));
vi.mock('@/lib/polls',()=>({attachPollsToPosts:async()=>{}}));
vi.mock('@/lib/postTags',()=>({attachTagsToPosts:async()=>{}}));
vi.mock('@/lib/visibleTopics',()=>({resolveVisibleTopicIds:async()=>['topic']}));
vi.mock('@/lib/postReadable',()=>({canReadPost:vi.fn().mockResolvedValue(true)}));
vi.mock('@/lib/explorer',()=>({txExplorerUrl:()=>null}));
vi.mock('@/lib/record',()=>({isContentHashMatch:()=>true}));
vi.mock('@/lib/chatUnread',()=>({readStatesForTopics:async()=>({}),emptyReadState:()=>({})}));
import {GET as postDetail} from '@/app/api/posts/[postId]/route';
import {GET as chatHistory} from '@/app/api/topics/[topicId]/chat/route';
import {GET as bookmarks} from '@/app/api/bookmarks/route';
import {GET as ownPosts} from '@/app/api/my/posts/route';
import {GET as likes} from '@/app/api/my/likes/route';
import {GET as recorded} from '@/app/api/recorded/route';
import {GET as ownRecorded} from '@/app/api/my/recorded/route';
import {GET as recordedOnMine} from '@/app/api/my/recorded-on-mine/route';
import {GET as feed} from '@/app/api/feed/route';
import {GET as requests} from '@/app/api/topics/[topicId]/requests/route';
import {GET as records} from '@/app/api/posts/[postId]/records/route';
import {GET as dms} from '@/app/api/dm/route';
import {GET as authSession} from '@/app/api/auth/session/route';
const expected=[{type:'kyc',label:'KYC'},{type:'workspace',label:'company.com',domain:'company.com'},{type:'oidc',label:'OIDC'}];
const topicId='00000000-0000-0000-0000-000000000001';
const request=(path:string)=>new NextRequest('http://localhost/api/'+path);
beforeEach(()=>{
  state.rows=[];state.redis.clear();state.session.mockResolvedValue({userId:'alice',nickname:'Alice'});
  state.member.mockResolvedValue({role:'owner'});
  state.mget.mockReset().mockImplementation(async(...keys:string[])=>keys.map(k=>state.redis.get(k)??null));
  for(const type of ['kyc','country','oidc_domain','oidc_login']) state.redis.set('community:verification:v2:alice:'+type,JSON.stringify({verifiedAt:1,expiresAt:Date.now()+60000,...(type==='oidc_domain'?{domain:'company.com'}:{})}));
  state.redis.set('community:badge-visibility:alice:country','false');
});
describe('public identity badges on every post list',()=>{
  it.each([['bookmarks',bookmarks],['my/posts',ownPosts],['my/likes',likes],['my/recorded',ownRecorded],['my/recorded-on-mine',recordedOnMine],['recorded',recorded]] as const)('%s batches visible badges, never hidden or withdrawn identities',async(path,handler)=>{
    if(path==='recorded') state.rows.push([{topicId:'topic'}]);
    state.rows.push([{id:'p1',authorId:'alice',authorNickname:'Alice'},{id:'p2',authorId:'alice'},
      {id:'p3',authorId:null},{id:'p4',authorId:'withdrawn:1:alice'}]);
    const response=await handler(request(path));
    expect(response.status).toBe(200);
    const data=await response.json();
    expect(data.posts.map((p:{badges:unknown[]})=>p.badges)).toEqual([expected,expected,[],[]]);
    expect(state.mget).toHaveBeenCalledTimes(1);
  });
  it.each([null,{userId:'alice'}])('guest and authenticated open/different-proof posts expose identical public badges (%j)',async session=>{
    state.session.mockResolvedValue(session);
    if(session) state.rows.push([{topicId:'topic'}]);
    state.rows.push([{id:'open',authorId:'alice',topicProofType:'none'},{id:'other',authorId:'alice',topicProofType:'country'}]);
    const response=await feed(request('feed'));
    expect(response.status).toBe(200);
    expect((await response.json()).posts.map((p:{badges:unknown[]})=>p.badges)).toEqual([expected,expected]);
    expect(state.mget).toHaveBeenCalledTimes(1);
  });
});
describe('other identity response contracts',()=>{
  it('public post detail preserves all visible badges but masks deleted comment authors completely',async()=>{
    state.session.mockResolvedValue(null);
    state.rows.push([{id:topicId,authorId:'alice',topicVisibility:'public',topicProofType:'none'}],
      [{id:'visible',authorId:'alice'},{id:'deleted',authorId:'alice',deletedAt:new Date(),deletedBy:'author'}],[]);
    const response=await postDetail(request('posts/'+topicId),{params:Promise.resolve({postId:topicId})});
    expect(response.status).toBe(200);
    const body=await response.json();
    expect(body.post.badges).toEqual(expected);
    expect(body.comments[0].badges).toEqual(expected);
    expect(body.comments[1]).toMatchObject({authorId:null,authorNickname:null,authorProfileImage:null,badges:[]});
    expect(state.mget).toHaveBeenCalledTimes(1);
  });
  it('chat history batches current public author badges while ciphertext stays sealed',async()=>{
    state.rows.push([{id:'chat',userId:'alice',nickname:'Alice',type:'message',ciphertext:Buffer.from('sealed'),epoch:1}], [{value:1}]);
    const response=await chatHistory(request('topics/'+topicId+'/chat'),{params:Promise.resolve({topicId})});
    expect(response.status).toBe(200);
    const body=await response.json();
    expect(body.messages[0]).toMatchObject({badges:expected,message:null,sealed:{ciphertext:Buffer.from('sealed').toString('base64')}});
    expect(state.mget).toHaveBeenCalledTimes(1);
  });
  it('join requests carry requester badges',async()=>{
    state.rows.push([{userId:'alice',nickname:'Alice'}]);
    const response=await requests(request('topics/'+topicId+'/requests'),{params:Promise.resolve({topicId})});
    expect(response.status).toBe(200);
    expect((await response.json()).requests[0].badges).toEqual(expected);
  });
  it('recorders carry recorderId and current public recorderBadges',async()=>{
    state.rows.push([{id:topicId,content:'text'}],[{id:'record',recorderNullifier:'alice',recorderNickname:'Alice'}]);
    const response=await records(request('posts/'+topicId+'/records'),{params:Promise.resolve({postId:topicId})});
    expect(response.status).toBe(200);
    expect((await response.json()).records[0]).toMatchObject({recorderId:'alice',recorderBadges:expected});
  });
  it('DM room peer carries all public badge types',async()=>{
    state.session.mockResolvedValue({userId:'viewer'});
    state.rows.push([{topicId}],[{topicId,peerId:'alice',nickname:'Alice'}]);
    const response=await dms(request('dm'));
    expect(response.status).toBe(200);
    expect((await response.json()).dms[0].peer.badges).toEqual(expected);
  });
  it('session contains only public badges and remains valid if optional badge Redis lookup fails',async()=>{
    state.rows.push([{nickname:'Alice',profileImage:'https://example.com/alice.png'}]);
    expect(await (await authSession(request('auth/session'))).json()).toMatchObject({badges:expected,profileImage:'https://example.com/alice.png'});
    state.rows.push([{nickname:'Alice'}]);
    state.mget.mockRejectedValueOnce(new Error('Redis unavailable'));
    const response=await authSession(request('auth/session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({userId:'alice',nickname:'Alice',badges:[]});
  });
});
