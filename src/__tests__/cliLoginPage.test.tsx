// @vitest-environment jsdom
/** Browser handoff contract. Real UI/i18n/deadline code; only HTTP, QR rendering
 * and browser navigation are replaced. No real proof/cookie minting is asserted. */
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import CliLoginPage from '@/components/CliLoginPage';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import {translate} from '@/lib/i18n';

vi.mock('qrcode',()=>({toDataURL:async()=> 'data:image/png;base64,login-test'}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const loginId='3a2b20ea-8a6d-4b50-8cc7-4d46bbfd9db6';
const approvalToken='a'.repeat(64);
const endpoint=`/api/auth/cli-login/${loginId}`;
const deepLink='zkproofport://proof-request?data='+Buffer.from(JSON.stringify({requestId:'relay-login-request',circuitId:'oidc_domain_attestation',scope:'',inputs:{scope:'zkproofport-community',provider:'google'},callbackUrl:'https://relay.zkproofport.app/api/v1/proof/callback'})).toString('base64url');
const response=(data:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data}) as Response;
const actualWindow=window;
let root:Root;
let container:HTMLDivElement;
let fetchMock:ReturnType<typeof vi.fn>;
let assign:ReturnType<typeof vi.fn>;
let replaceState:ReturnType<typeof vi.fn>;
let location:{hash:string;search:string;origin:string;pathname:string;href:string;assign:ReturnType<typeof vi.fn>};
function setAddress(address:string){
 const url=new URL(address,'http://localhost:3200');
 Object.assign(location,{hash:url.hash,search:url.search,origin:url.origin,pathname:url.pathname,href:url.href});
}
beforeEach(()=>{
 vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(()=>{});
 assign=vi.fn();location={hash:'',search:'',origin:'http://localhost:3200',pathname:'/login',href:'',assign};
 setAddress(`/login?loginId=${loginId}#approvalToken=${approvalToken}`);
 replaceState=vi.fn((_state:unknown,_title:string,url:string)=>setAddress(url));
 const browserWindow=Object.create(actualWindow);
 Object.defineProperties(browserWindow,{location:{value:location},history:{value:{replaceState}}});
 vi.stubGlobal('window',browserWindow);
 fetchMock=vi.fn(async()=>response({status:'pending',deepLink}));vi.stubGlobal('fetch',fetchMock);
 container=document.createElement('div');root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function render(locale:'en'|'ko'='en'){
 await act(async()=>root.render(<I18nProvider initialLocale={locale}><CliLoginPage/></I18nProvider>));
 expect(container.textContent).not.toContain('cliLogin.');
}
async function press(key:string,locale:'en'|'ko'='en'){
 const label=translate(locale,`cliLogin.${key}`);
 const button=Array.from(container.querySelectorAll('button')).find(node=>node.textContent?.trim()===label);
 expect(button,`Missing ${key} button`).toBeDefined();
 await act(async()=>button!.click());
}
function assertNoSecretExposure(){
 expect(container.textContent).not.toContain(approvalToken);
 expect(container.innerHTML).not.toContain(approvalToken);
 expect(location.hash).toBe('');
 for(const [url,init] of fetchMock.mock.calls){
  expect(url).toBe(endpoint);
  expect(String(url)).not.toContain(approvalToken);
  expect(JSON.stringify(init?.headers??{})).not.toContain(approvalToken);
  expect(init?.referrerPolicy).toBe('no-referrer');
 }
}
it.each(['en','ko'] as const)('waits for explicit consent in %s and removes the fragment before any request',async locale=>{
 await render(locale);
 expect(container.textContent).toContain(translate(locale,'cliLogin.title'));
 expect(container.textContent).toContain(translate(locale,'cliLogin.approve'));
 expect(container.textContent).toContain(translate(locale,'cliLogin.decline'));
 expect(replaceState).toHaveBeenCalled();
 expect(fetchMock).not.toHaveBeenCalled();
 expect(container.querySelector('img')).toBeNull();
 assertNoSecretExposure();
});
it('approval starts and polls only the credential-bearing same-origin POST, then renders QR',async()=>{
 await render();await press('approve');
 expect(fetchMock).toHaveBeenCalledTimes(1);
 expect(fetchMock.mock.calls[0][1]).toMatchObject({method:'POST'});
 expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({approvalToken});
 expect(container.querySelector('img')?.getAttribute('src')).toContain('data:image/png');
 expect(container.querySelector('a[href^="zkproofport:"]')?.getAttribute('href')).toBe(deepLink);
 await act(async()=>vi.advanceTimersByTimeAsync(2000));
 expect(fetchMock).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({approvalToken});
 assertNoSecretExposure();
});
it('preserves the in-memory approval secret across React StrictMode effect replay',async()=>{
 await act(async()=>root.render(<React.StrictMode><I18nProvider initialLocale="en"><CliLoginPage/></I18nProvider></React.StrictMode>));
 expect(fetchMock).not.toHaveBeenCalled();expect(location.hash).toBe('');
 await press('approve');
 expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({approvalToken});
});
it('double approval creates only one in-flight request',async()=>{
 fetchMock.mockImplementation(()=>new Promise(()=>{}));await render();
 const button=Array.from(container.querySelectorAll('button')).find(node=>node.textContent?.trim()===translate('en','cliLogin.approve'))!;
 await act(async()=>{button.click();button.click();});
 expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('cancelling pending approval suppresses a late successful poll response',async()=>{
 let resolve!:(value:Response)=>void;
 fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue(response({status:'cancelled'}));
 await render();await press('approve');await press('decline');
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({approvalToken,cancel:true});
 await act(async()=>resolve(response({status:'completed',redirectUrl:'/my'})));
 expect(assign).not.toHaveBeenCalled();expect(container.textContent).toContain(translate('en','cliLogin.cancelled'));
 await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('keeps cancellation terminal when the superseded poll fails later',async()=>{
 let reject!:(error:Error)=>void;
 fetchMock.mockImplementationOnce(()=>new Promise((_resolve,r)=>{reject=r;})).mockResolvedValue(response({status:'cancelled'}));
 await render();await press('approve');await press('decline');
 await act(async()=>reject(new Error('late transport failure')));
 expect(assign).not.toHaveBeenCalled();expect(container.textContent).toContain(translate('en','cliLogin.cancelled'));
});
it.each([null,{}, {status:'surprise'},{status:'pending',deepLink:'https://attacker.test/collect'},{status:'pending',deepLink:'javascript:alert(1)'}])('rejects malformed or unsafe server responses (case %#)',async data=>{
 fetchMock.mockResolvedValue(response(data));await render();await press('approve');
 expect(assign).not.toHaveBeenCalled();expect(container.querySelector('img')).toBeNull();
 expect(container.textContent).toContain(translate('en','cliLogin.error'));
 await act(async()=>vi.advanceTimersByTimeAsync(4000));expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('decline cancels server-side without starting proof and stops all polling',async()=>{
 fetchMock.mockResolvedValue(response({status:'cancelled'}));
 await render();await press('decline');
 expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({approvalToken,cancel:true});
 expect(container.textContent).toContain(translate('en','cliLogin.cancelled'));
 await act(async()=>vi.advanceTimersByTimeAsync(6000));
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(assign).not.toHaveBeenCalled();
});
it('completion redirects to the same-origin destination without reading or exposing tokens',async()=>{
 fetchMock.mockResolvedValue(response({status:'completed',redirectUrl:'/my',userId:'opaque-user',nickname:'검증 사용자 🔐'}));
 await render();await press('approve');
 expect(assign).toHaveBeenCalledExactlyOnceWith('/my');
 expect(fetchMock.mock.calls.every(call=>call[0]===endpoint)).toBe(true);
 assertNoSecretExposure();
});
it.each(['https://attacker.test/collect','//attacker.test','javascript:alert(1)','/\\attacker.test','/\n/attacker.test','https://localhost:3200/my','my',''])('rejects unsafe redirect %j',async redirectUrl=>{
 fetchMock.mockResolvedValue(response({status:'completed',redirectUrl}));
 await render();await press('approve');
 expect(assign).not.toHaveBeenCalled();
 expect(container.textContent).toContain(translate('en','cliLogin.error'));
});
it.each([400,401,403,404,410])('handles HTTP %i with localized terminal guidance and no redirect',async status=>{
 fetchMock.mockResolvedValue(response({error:'raw-server-secret-'+approvalToken},status));
 await render();await press('approve');
 expect(assign).not.toHaveBeenCalled();
 expect(container.textContent).toContain(translate('en',status===410?'cliLogin.expired':'cliLogin.error'));
 expect(container.textContent).not.toContain('raw-server-secret');
 const count=fetchMock.mock.calls.length;
 await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(fetchMock).toHaveBeenCalledTimes(count);
});
it.each([
 '/login',`/login?loginId=${loginId}`,`/login?loginId=${loginId}&approvalToken=${approvalToken}`,
 `/login?loginId=../outside#approvalToken=${approvalToken}`,`/login?loginId=${loginId}#approvalToken=`,
 `/login?loginId=${loginId}#approvalToken=${'a'.repeat(10000)}`,
 `/login?loginId=${encodeURIComponent('<script>bad</script>')}#approvalToken=${approvalToken}`,
])('rejects missing or hostile handoff inputs (case %#)',async url=>{
 setAddress(url);await render();
 expect(container.textContent).toContain(translate('en','cliLogin.invalid'));
 expect(fetchMock).not.toHaveBeenCalled();expect(assign).not.toHaveBeenCalled();
});
it('ignores late completion after unmount',async()=>{
 let resolve!:(value:Response)=>void;fetchMock.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 await render();await press('approve');
 act(()=>root.unmount());
 await act(async()=>resolve(response({status:'completed',redirectUrl:'/my'})));
 expect(assign).not.toHaveBeenCalled();
 root=createRoot(container);
});
it('bounds a server request that never answers without overlapping repeated polls',async()=>{
 fetchMock.mockImplementation(()=>new Promise(()=>{}));await render();await press('approve');
 await act(async()=>vi.advanceTimersByTimeAsync(14000));expect(fetchMock).toHaveBeenCalledTimes(1);
 await act(async()=>vi.advanceTimersByTimeAsync(10*60*1000));
 expect(assign).not.toHaveBeenCalled();
 expect(container.querySelector('img')).toBeNull();
 expect(container.textContent).toMatch(new RegExp(`${translate('en','cliLogin.expired')}|${translate('en','cliLogin.error')}`));
 const count=fetchMock.mock.calls.length;await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(fetchMock).toHaveBeenCalledTimes(count);
});
it('expires even if response headers arrive but reading its JSON body stalls',async()=>{
 fetchMock.mockResolvedValue({ok:true,status:200,json:()=>new Promise(()=>{})} as Response);
 await render();await press('approve');
 await act(async()=>vi.advanceTimersByTimeAsync(10*60*1000+2000));
 expect(container.textContent).toContain(translate('en','cliLogin.expired'));
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(assign).not.toHaveBeenCalled();
});

it.each(['en','ko'] as const)('consent copy appears once and approval actions are visibly styled in %s',async locale=>{
 await render(locale);
 const consent=translate(locale,'cliLogin.consent');
 expect(container.textContent!.split(consent).length-1).toBe(1);
 for(const key of ['approve','decline']){
  const button=Array.from(container.querySelectorAll('button')).find(node=>node.textContent?.trim()===translate(locale,`cliLogin.${key}`));
  expect(button?.className).toMatch(/os-button/);
 }
 expect(fetchMock).not.toHaveBeenCalled();
 expect(container.querySelector('img')).toBeNull();
 await press('approve',locale);
 expect(container.querySelector('img')?.getAttribute('src')).toContain('data:image/png');
});
