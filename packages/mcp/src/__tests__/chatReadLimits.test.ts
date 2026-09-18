import {describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import type {Commands} from '@masselabs/openstoa-commands';
import {registerTools,type ToolHost,type ToolResult} from '../tools';

function setup(){
 const calls={chatRead:vi.fn().mockResolvedValue([]),dmRead:vi.fn().mockResolvedValue([]),postList:vi.fn().mockResolvedValue([])};
 const tools=new Map<string,{schema:z.ZodObject<Record<string,z.ZodTypeAny>>;run:(input:Record<string,unknown>)=>Promise<ToolResult>}>();
 const host:ToolHost={tool(name,_description,fields,run){tools.set(name,{schema:z.object(fields),run});}};
 registerTools(host,calls as unknown as Commands);
 return {calls,tools};
}

describe.each([['openstoa_chat_read','chatRead'],['openstoa_dm_read','dmRead']] as const)('%s uses the server chat paging range',(name,method)=>{
 it.each([undefined,1,100,500])('accepts and forwards limit %s without substituting a client default',async limit=>{
  const {calls,tools}=setup();const tool=tools.get(name)!;
  const input={topicId:'topic',...(limit===undefined?{}:{limit})};
  const parsed=tool.schema.parse(input);
  if(limit===undefined)expect(parsed).not.toHaveProperty('limit');
  const result=await tool.run(parsed);
  expect(result.isError).not.toBe(true);
  expect(calls[method]).toHaveBeenCalledExactlyOnceWith('topic',{limit,since:undefined,before:undefined});
 });
 it.each([0,501,1.5])('rejects invalid limit %s before command dispatch',limit=>{
  const {calls,tools}=setup();
  expect(tools.get(name)!.schema.safeParse({topicId:'topic',limit}).success).toBe(false);
  expect(calls[method]).not.toHaveBeenCalled();
 });
});

describe('post paging keeps its separate 100-result ceiling',()=>{
 it('accepts100 and rejects101/500 without broadening post_list',async()=>{
  const {calls,tools}=setup();const tool=tools.get('openstoa_post_list')!;
  await tool.run(tool.schema.parse({topicId:'topic',limit:100}));
  expect(calls.postList).toHaveBeenCalledExactlyOnceWith('topic',{limit:100});
  for(const limit of [101,500])expect(tool.schema.safeParse({topicId:'topic',limit}).success).toBe(false);
 });
});
