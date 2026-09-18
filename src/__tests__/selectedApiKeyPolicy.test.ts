import {expect,it,vi} from 'vitest';
vi.mock('@/lib/db',()=>({db:{}}));
import {requireAiCapability} from '@/lib/aiPermissions';

it.each([false,true,undefined])('an empty selected key denies actions even when isAI=%s',async isAI=>{
 const session={userId:'account',isAI,apiKeyId:'selected',apiKeyCmd:[]};
 const result=await requireAiCapability({} as never,session,'/openstoa/chat/send');
 expect(result?.status).toBe(403);
});
it.each([false,true,undefined])('a selected key permits only its exact capability when isAI=%s',async isAI=>{
 const session={userId:'account',isAI,apiKeyId:'selected',apiKeyCmd:['/openstoa/chat/read']};
 expect(await requireAiCapability({} as never,session,'/openstoa/chat/read')).toBeNull();
 expect((await requireAiCapability({} as never,session,'/openstoa/chat/send'))?.status).toBe(403);
});
it('a selected key with absent scope fails closed instead of inheriting human permissions',async()=>{
 const session={userId:'account',isAI:false,apiKeyId:'selected'};
 expect((await requireAiCapability({} as never,session,'/openstoa/chat/send'))?.status).toBe(403);
});
it('owner browser sessions without a selected key retain ordinary account behavior',async()=>{
 expect(await requireAiCapability({} as never,{userId:'owner',isAI:false},'/openstoa/chat/send')).toBeNull();
});
