// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({upload:vi.fn()}));
vi.mock('@/lib/apiFetch',()=>({apiFetch:mocks.upload,UPLOAD_REQUEST_TIMEOUT_MS:90000}));
vi.mock('@/lib/i18n/I18nProvider',()=>({useTranslation:()=>({locale:'en',t:(key:string)=>key})}));
import SNSEditor from '@/components/SNSEditor';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null;let container:HTMLDivElement;
const onChange=vi.fn();
const uploaded=()=>({ok:true,json:async()=>({publicUrl:'https://cdn.test/image.png'})});
beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks();vi.spyOn(window,'alert').mockImplementation(()=>{});
 mocks.upload.mockResolvedValue(uploaded());container=document.createElement('div');root=createRoot(container);
});
afterEach(()=>{if(root)act(()=>root!.unmount());root=null;vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
async function render(maxImages=10){await act(async()=>root!.render(<SNSEditor onChange={onChange} maxImages={maxImages}/>));await act(async()=>vi.advanceTimersByTimeAsync(0));}
async function chooseFile(){
 const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;
 Object.defineProperty(input,'files',{configurable:true,value:[new File(['image'],'photo.png',{type:'image/png'})]});
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
}
function unmount(){act(()=>root!.unmount());root=null;}
it('cancels the delayed upload-indicator reset when the editor unmounts',async()=>{
 await render();await chooseFile();expect(onChange).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(1);
 unmount();expect(vi.getTimerCount()).toBe(0);
});
it('a late upload response after unmount cannot emit draft state or create a reset timer',async()=>{
 let finish!:(value:ReturnType<typeof uploaded>)=>void;mocks.upload.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 await render();await chooseFile();unmount();
 await act(async()=>finish(uploaded()));
 expect(onChange).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('a new upload cancels the previous batch reset until the new upload completes',async()=>{
 await render();await chooseFile();await act(async()=>vi.advanceTimersByTimeAsync(250));
 let finish!:(value:ReturnType<typeof uploaded>)=>void;mocks.upload.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 await chooseFile();expect(vi.getTimerCount()).toBe(0);
 await act(async()=>vi.advanceTimersByTimeAsync(251));expect(container.textContent).toContain('snsEditor.uploading');
 await act(async()=>finish(uploaded()));expect(vi.getTimerCount()).toBe(1);
 await act(async()=>vi.advanceTimersByTimeAsync(500));expect(container.textContent).not.toContain('snsEditor.uploading');
});
it('also clears an image-limit notification timer when the editor is removed',async()=>{
 await render(0);await chooseFile();expect(mocks.upload).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(1);
 unmount();expect(vi.getTimerCount()).toBe(0);
});
it('a mounted completed upload still hides its indicator after the original 500ms delay',async()=>{
 await render();await chooseFile();await act(async()=>vi.advanceTimersByTimeAsync(499));
 expect(container.textContent).toContain('snsEditor.uploading');
 await act(async()=>vi.advanceTimersByTimeAsync(1));expect(container.textContent).not.toContain('snsEditor.uploading');
});
it('overlapping upload completions keep only one reset timer for unmount cleanup',async()=>{
 const finish:Array<(value:ReturnType<typeof uploaded>)=>void>=[];
 mocks.upload.mockImplementation(()=>new Promise(resolve=>finish.push(resolve)));
 await render();await chooseFile();await chooseFile();
 await act(async()=>finish[0](uploaded()));await act(async()=>finish[1](uploaded()));
 expect(vi.getTimerCount()).toBe(1);unmount();expect(vi.getTimerCount()).toBe(0);
});
