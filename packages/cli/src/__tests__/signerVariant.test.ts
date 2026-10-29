/**
 * --signer-variant names the circuit package that made a supplied --proof.
 * Each known value reaches the command unchanged on topics create / join /
 * join-invite, an absent flag stays absent, and an unknown value is refused by
 * commander (naming it and the choices) before any command runs.
 */
import {describe,expect,it,vi} from 'vitest';
import type {Commands} from '@masselabs/openstoa-commands';
import {buildProgram} from '../cli';

const VARIANTS=['standard','android','android_factory'] as const;
const commands={
 create:['topics','create','--title','A topic','--category-id','c1','--proof-type','kyc','--proof','0xab','--public-inputs','0xcd'],
 join:['topics','join','t1','--proof','0xab','--public-inputs','0xcd'],
 'join-invite':['topics','join-invite','code','--proof','0xab','--public-inputs','0xcd'],
} as const;
type Name=keyof typeof commands;
function program(factory:(...a:unknown[])=>unknown,errors:string[]=[]){
 const built=buildProgram(factory as never,()=>{}).exitOverride().configureOutput({writeErr:(text)=>errors.push(text)});
 const topics=built.commands.find(command=>command.name()==='topics')!;
 for(const command of topics.commands)command.exitOverride().configureOutput({writeErr:(text)=>errors.push(text)});
 return built;
}
function dispatched(name:Name,spies:{topicCreate:ReturnType<typeof vi.fn>;topicJoin:ReturnType<typeof vi.fn>;executeOperation:ReturnType<typeof vi.fn>}){
 if(name==='create')return spies.topicCreate.mock.calls[0]?.[0];
 if(name==='join')return spies.topicJoin.mock.calls[0]?.[1];
 return spies.executeOperation.mock.calls[0]?.[1];
}
function fakes(){
 const spies={topicCreate:vi.fn().mockResolvedValue({id:'topic'}),topicJoin:vi.fn().mockResolvedValue({topicId:'t1',joined:true}),executeOperation:vi.fn().mockResolvedValue({success:true})};
 return {spies,factory:vi.fn(async()=>spies as unknown as Commands)};
}
describe.each(Object.keys(commands) as Name[])('topics %s --signer-variant',name=>{
 it.each(VARIANTS)('forwards %s unchanged',async variant=>{
  const {spies,factory}=fakes();
  await program(factory).parseAsync(['node','openstoa','--json',...commands[name],'--signer-variant',variant]);
  expect(dispatched(name,spies)).toMatchObject({proof:'0xab',publicInputs:'0xcd',signerVariant:variant});
 });
 it('leaves an absent flag absent',async()=>{
  const {spies,factory}=fakes();
  await program(factory).parseAsync(['node','openstoa','--json',...commands[name]]);
  expect(dispatched(name,spies)).toMatchObject({proof:'0xab',publicInputs:'0xcd'});
  expect(dispatched(name,spies).signerVariant).toBeUndefined();
 });
 it.each(['ios','','ANDROID',' android','__proto__'])('refuses %j by name before any command runs',async variant=>{
  const {factory}=fakes();const errors:string[]=[];
  await expect(program(factory,errors).parseAsync(['node','openstoa','--json',...commands[name],'--signer-variant',variant])).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
  expect(errors.join('')).toContain(`'${variant}' is invalid`);
  expect(errors.join('')).toContain('standard, android, android_factory');
 });
});
