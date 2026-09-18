import {describe,expect,it,vi} from 'vitest';
import type {Commands} from '@masselabs/openstoa-commands';
import {buildProgram} from '../cli';

const proofTypes=['none','kyc','country','google_workspace','microsoft_365','workspace'] as const;
describe('CLI topic proof types match the server',()=>{
 it.each(proofTypes)('accepts %s and forwards proof restrictions and bytes',async(proofType)=>{
  const topicCreate=vi.fn().mockResolvedValue({id:'topic'});
  const program=buildProgram(async()=>({topicCreate} as unknown as Commands),()=>{}).exitOverride();
  program.commands.find(command=>command.name()==='topics')!.commands.find(command=>command.name()==='create')!.exitOverride().configureOutput({writeErr:()=>{}});
  await program.parseAsync(['node','openstoa','--json','topics','create','--title','A topic','--category-id','category','--proof-type',proofType,'--required-domain','company.com','--allowed-countries','KR, US','--proof','0xab','--public-inputs','0xcd']);
  expect(topicCreate).toHaveBeenCalledOnce();
  expect(topicCreate).toHaveBeenCalledWith(expect.objectContaining({proofType,requiredDomain:'company.com',allowedCountries:['KR','US'],proof:'0xab',publicInputs:'0xcd'}));
 });
 it.each(['unknown','', '__proto__'])('rejects unsupported proof type %j before dispatch',async(proofType)=>{
  const factory=vi.fn();
  const program=buildProgram(factory,()=>{}).exitOverride().configureOutput({writeErr:()=>{}});
  program.commands.find(command=>command.name()==='topics')!.commands.find(command=>command.name()==='create')!.exitOverride().configureOutput({writeErr:()=>{}});
  await expect(program.parseAsync(['node','openstoa','topics','create','--title','A topic','--proof-type',proofType])).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
 });
});
