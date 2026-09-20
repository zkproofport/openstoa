/** Actual POSIX terminal regression: pasting as soon as the prompt is visible
 * must never echo a permission key. No server, account, or real secret is used. */
import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

const ptyRunner=String.raw`
import errno,json,os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
process=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
output=b'';sent=False;deadline=time.monotonic()+8
secret='osk_'+'d'*48
try:
 while time.monotonic()<deadline:
  if not select.select([master],[],[],0.05)[0]:
   if process.poll() is not None:break
   continue
  try:chunk=os.read(master,65536)
  except OSError as error:
   if error.errno==errno.EIO:break
   raise
  if not chunk:break
  output+=chunk
  if b'API key (hidden): ' in output and not sent:
   os.write(master,(secret+'\n').encode());sent=True
 if process.poll() is None:process.wait(timeout=2)
 print(json.dumps({'sent':sent,'accepted':b'SECRET_ACCEPTED' in output,'echoed':secret.encode() in output,'returncode':process.returncode}))
finally:
 if process.poll() is None:process.kill();process.wait()
 os.close(master)
`;
async function checkPrompt(source:string){
 const directory=await mkdtemp(join(tmpdir(),'openstoa-tty-secret-'));directories.push(directory);
 // Compile only the real terminal helper and its pure formatter using the
 // already-declared TypeScript dev dependency; no tsx or new package required.
 const compile=(text:string)=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 await writeFile(join(directory,'proofInteraction.mjs'),compile(source).replace("from './format'","from './format.mjs'"));
 await writeFile(join(directory,'format.mjs'),compile(await readFile(resolve(process.cwd(),'src/format.ts'),'utf8')));
 await writeFile(join(directory,'prompt.mjs'),String.raw`
import {defaultProofTerminal} from './proofInteraction.mjs';
const original=process.stderr.write.bind(process.stderr);
process.stderr.write=(chunk,...args)=>{
 const result=original(chunk,...args);
 // Widen exactly the vulnerable interval after the prompt becomes visible.
 // A real PTY peer can now paste while this process is blocked.
 if(String(chunk).includes('API key (hidden): '))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
 return result;
};
const value=await defaultProofTerminal.askSecret('API key (hidden): ');
if(value==='osk_'+'d'.repeat(48))process.stdout.write('SECRET_ACCEPTED\n');
process.stdin.pause();
`);
 const child=spawnSync('python3',['-c',ptyRunner,process.execPath,join(directory,'prompt.mjs')],{encoding:'utf8',timeout:15000});
 expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
 return JSON.parse(child.stdout) as {sent:boolean;accepted:boolean;echoed:boolean;returncode:number};
}
it.skipIf(process.platform==='win32')('disables terminal echo before showing a secret prompt, including immediate paste',async()=>{
 const source=await readFile(resolve(process.cwd(),'src/proofInteraction.ts'),'utf8');
 const actual=await checkPrompt(source);
 expect(actual).toEqual({sent:true,accepted:true,echoed:false,returncode:0});
 // Negative control reintroduces the original ordering only in a temporary
 // copy; the same actual PTY must then catch the leaked dummy secret.
 const prompt='    process.stderr.write(question);';
 const reader='    const reader = createInterface({input:process.stdin,output:silent,terminal:true});';
 expect(source).toContain(prompt);expect(source).toContain(reader);
 const broken=source.replace(prompt,'').replace(reader,prompt+'\n'+reader);
 const control=await checkPrompt(broken);
 expect(control.sent).toBe(true);expect(control.accepted).toBe(true);expect(control.echoed).toBe(true);
},20000);
