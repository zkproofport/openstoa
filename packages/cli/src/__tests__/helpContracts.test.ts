import {describe,it,expect,vi} from 'vitest';
import type {Commands} from '@masselabs/openstoa-commands';
import {buildProgram} from '../cli';
function help(...path:string[]){
 let cmd=buildProgram(async()=>({} as Commands),()=>{});
 for(const name of path)cmd=cmd.commands.find(c=>c.name()===name)!;
 let output='';cmd.configureOutput({writeOut:s=>{output+=s;}}).outputHelp();return output.replace(/\s+/g,' ');
}
describe('help reflects current authentication and proof contracts',()=>{
 it('never offers a key flag as a way to change session identity',()=>{
  expect(help('apikey','create')).not.toMatch(/mark sessions authenticated with this key/);
  expect(help('apikey','create')).toMatch(/metadata.*does not change.*session/i);
 });
 it('explains agent sessions cannot manage keys even without a selected key',()=>{
  expect(help('apikey')).toMatch(/agent sessions.*without.*key/i);
 });
 it('does not imply uploaded media is universally public',()=>{
  expect(help('upload')).not.toContain('public URL');expect(help('upload')).toMatch(/10\s?MB/);
 });
 it('explains AI process lifetime for login and topic actions',()=>{
  for(const path of [['login'],['topics','create'],['topics','join'],['topics','join-invite']])
   expect(help(...path)).toMatch(/AI.*requires --wait.*non-interactive/i);
 });
 it('makes existing-proof and generated-proof exclusivity discoverable',()=>{
  for(const path of [['topics','create'],['topics','join'],['topics','join-invite']])
   expect(help(...path)).toMatch(/cannot.*(?:combine|combined).*--method/i);
 });
 it('marks the server-required creation category in help',()=>{
  expect(help('topics','create')).toMatch(/--category-id <id>.*required/i);
 });
 it('states the chat keystore limitation',()=>{expect(help()).toMatch(/keychain.*not supported.*chat/i);});
 it('renders every command help without creating a client',async()=>{
  const factory=vi.fn(async()=>({} as Commands));const root=buildProgram(factory,()=>{});const paths:string[][]=[];
  function walk(cmd:typeof root,path:string[]){paths.push(path);for(const child of cmd.commands)walk(child,[...path,child.name()]);}
  walk(root,[]);expect(paths.length).toBeGreaterThan(70);
  for(const path of paths){
   const program=buildProgram(factory,()=>{});
   function capture(cmd:typeof program){cmd.exitOverride().configureOutput({writeOut:()=>{},writeErr:()=>{}});cmd.commands.forEach(capture);}
   capture(program);
   await expect(program.parseAsync([...path,'--help'],{from:'user'})).rejects.toMatchObject({code:'commander.helpDisplayed',exitCode:0});
  }
  expect(factory).not.toHaveBeenCalled();
 });
});
