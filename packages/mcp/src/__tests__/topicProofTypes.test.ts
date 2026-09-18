import {describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import type {Commands} from '@masselabs/openstoa-commands';
import {registerTools,type ToolResult} from '../tools';
const proofTypes=['none','kyc','country','google_workspace','microsoft_365','workspace'] as const;
function setup(){
 const topicCreate=vi.fn().mockResolvedValue({id:'topic'});
 let schema: z.ZodObject<Record<string,z.ZodTypeAny>>;
 let handler:(a:Record<string,unknown>)=>Promise<ToolResult>;
 registerTools({tool(name,_description,fields,fn){if(name==='openstoa_topic_create'){schema=z.object(fields);handler=fn;}}},{topicCreate} as unknown as Commands);
 return {topicCreate,schema:schema!,handler:handler!};
}
describe('MCP topic proof types match the server',()=>{
 it.each(proofTypes)('accepts %s and forwards proof restrictions and bytes',async(proofType)=>{
  const {topicCreate,schema,handler}=setup();
  const input={title:'A topic',categoryId:'category',proofType,requiredDomain:'company.com',allowedCountries:['KR','US'],proof:'0xab',publicInputs:'0xcd'};
  expect((await handler(schema.parse(input))).isError).toBeUndefined();
  expect(topicCreate).toHaveBeenCalledOnce();
  expect(topicCreate).toHaveBeenCalledWith(expect.objectContaining(input));
 });
 it.each(['unknown','', '__proto__',null,42])('rejects unsupported proof type %j at the tool schema',proofType=>{
  const {topicCreate,schema}=setup();
  expect(schema.safeParse({title:'A topic',proofType}).success).toBe(false);
  expect(topicCreate).not.toHaveBeenCalled();
 });
});
