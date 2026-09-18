// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import AiAgentSettings from '@/components/AiAgentSettings';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import {translate} from '@/lib/i18n';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const read='/openstoa/chat/read',send='/openstoa/chat/send',write='/openstoa/post/write';
const makeKey=(id:string,name:string,cmd:string[],historyGrant:string)=>({id,name,cmd,historyGrant,prefix:'osk_'+id,isAI:true,createdAt:null,lastUsedAt:null,revokedAt:null});
let container:HTMLDivElement,root:Root,fetchMock:ReturnType<typeof vi.fn>;
const response=(value:unknown)=>({ok:true,status:200,json:async()=>value}) as Response;
beforeEach(()=>{
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
 const keys=[makeKey('first','읽기 전용 🔐',[read],'7d'),makeKey('second','writer',[send],'none')];
 fetchMock=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url==='/api/profile/api-keys'&&!init?.method)return response({apiKeys:keys,allowedCmd:[read,send,write]});
  if(url==='/api/profile/api-keys/first'&&init?.method==='PATCH')return response({key:{...keys[0],...JSON.parse(String(init.body))}});
  if(url==='/api/profile/api-keys/first'&&init?.method==='DELETE')return response({success:true});
  if(url==='/api/profile/api-keys'&&init?.method==='POST')return response({rawKey:'osk_disposable_fixture',key:makeKey('third','third',[], 'none')});
  throw new Error('unexpected request');
 });vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.unstubAllGlobals();});
async function render(locale:'en'|'ko'){await act(async()=>root.render(<I18nProvider initialLocale={locale}><AiAgentSettings/></I18nProvider>));}
function row(name:string){const nameNode=Array.from(container.querySelectorAll('span')).find(node=>node.textContent===name)!;expect(nameNode).toBeDefined();return nameNode.parentElement!.parentElement!;}
async function click(parent:HTMLElement,key:string,locale:'en'|'ko'){
 const target=Array.from(parent.querySelectorAll('button')).find(button=>button.textContent===translate(locale,key))!;
 expect(target).toBeDefined();await act(async()=>target.click());
}
it.each(['en','ko'] as const)('edits and revokes one key without changing another key (%s)',async locale=>{
 await render(locale);await click(row('읽기 전용 🔐'),'aiAgentSettings.editScope',locale);
 const checkbox=row('읽기 전용 🔐').querySelector<HTMLInputElement>(`input[id="edit-first-${write}"]`)!;
 await act(async()=>checkbox.click());await click(row('읽기 전용 🔐'),'aiAgentSettings.saveScope',locale);
 const patch=fetchMock.mock.calls.find(call=>call[1]?.method==='PATCH')!;
 expect(patch[0]).toBe('/api/profile/api-keys/first');expect(JSON.parse(String(patch[1].body))).toEqual({cmd:[read,write],historyGrant:'7d'});
 await click(row('writer'),'aiAgentSettings.editScope',locale);
 expect(row('writer').querySelector<HTMLInputElement>(`input[id="edit-second-${send}"]`)!.checked).toBe(true);
 expect(row('writer').querySelector<HTMLInputElement>(`input[id="edit-second-${read}"]`)!.checked).toBe(false);
 await click(row('writer'),'common.cancel',locale);
 await click(row('읽기 전용 🔐'),'aiAgentSettings.revoke',locale);
 expect(fetchMock.mock.calls.some(call=>call[1]?.method==='DELETE')).toBe(false);
 await click(row('읽기 전용 🔐'),'aiAgentSettings.confirm',locale);
 expect(row('읽기 전용 🔐').textContent).toContain(translate(locale,'aiAgentSettings.revoked'));
 expect(row('writer').textContent).not.toContain(translate(locale,'aiAgentSettings.revoked'));
 expect(row('writer').textContent).toContain(translate(locale,'aiAgentSettings.editScope'));
 expect(fetchMock.mock.calls.filter(call=>call[0]==='/api/profile/api-keys/second')).toHaveLength(0);
});
it('creating another key preserves all existing key rows',async()=>{
 await render('en');const input=container.querySelector<HTMLInputElement>('input[type="text"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'third');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await click(container,'aiAgentSettings.createKey','en');
 expect(row('읽기 전용 🔐')).toBeDefined();expect(row('writer')).toBeDefined();expect(row('third')).toBeDefined();
 expect(fetchMock.mock.calls.filter(call=>!call[1]?.method)).toHaveLength(1);
});
