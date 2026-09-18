// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import ProofPage from '@/components/HumanProofPage';
import {parseHumanProofFragment} from '@/lib/humanProofFragment';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import {translate} from '@/lib/i18n';
import {keccak256, toUtf8Bytes} from 'ethers';
vi.mock('qrcode', () => ({toDataURL: async () => 'data:image/png;base64,test'}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const scope = 'zkproofport-community:topic:private-account-id';
const requestId = 'relay-request-123';
const circuitType = 'coinbase_attestation';
const payload = {requestId, circuitId: circuitType, inputs:{scope}, callbackUrl:'https://relay.test/api/v1/proof/callback'};
const metadata = {requestId, scope, circuitType, deepLink:`zkproofport://proof-request?data=${encode(payload)}`};
const fragment = (override = {}) => `#${encode({...metadata, ...override})}`;
let root: Root | undefined;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState(null, '', `/proof${fragment()}`);
  fetchMock = vi.fn(async () => ({ok:true, status:200, json:async () => ({status:'pending'})}));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {act(() => root?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
async function render(locale: 'en'|'ko' = 'en') {
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><ProofPage relayOrigin="https://relay.test" /></I18nProvider>));
}
it('accepts the exact fragment contract and rejects credential-bearing metadata', () => {
  expect(parseHumanProofFragment(fragment(), 'https://relay.test')).toEqual(metadata);
  expect(parseHumanProofFragment(fragment({apiKey:'osk_secret'}), 'https://relay.test')).toBeNull();
  expect(parseHumanProofFragment(fragment({token:'secret'}), 'https://relay.test')).toBeNull();
});
it.each([
  '', '#not+base64', '#'+ 'a'.repeat(20001),
  fragment({requestId:'../evil'}), fragment({scope:'zkproofport-community'}),
  fragment({circuitType:'unknown'}), fragment({deepLink:'javascript:alert(1)'}),
  fragment({deepLink:`zkproofport://proof-request?data=${encode({...payload, requestId:'other'})}`}),
  fragment({deepLink:`zkproofport://proof-request?data=${encode({...payload, inputs:{scope:'other'}})}`}),
  fragment({deepLink:`zkproofport://proof-request?data=${encode({...payload, circuitId:'unknown'})}`}),
  fragment({deepLink:`${metadata.deepLink}&token=secret`}),
  fragment({deepLink:`zkproofport://proof-request?data=${encode({...payload, callbackUrl:'https://attacker.test/api/v1/proof/callback'})}`}),
  fragment({deepLink:`zkproofport://proof-request?data=${encode({...payload, callbackUrl:'https://relay.test.attacker.test/api/v1/proof/callback'})}`}),
])('rejects invalid fragment without QR, app link, or network request (case %#)', async hash => {
  window.history.replaceState(null, '', '/proof'+hash);
  await render();
  expect(container.textContent).toContain(translate('en','humanProof.invalid'));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a[href^="zkproofport:"]')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['en','ko'] as const)('renders localized request and polls only proof mode without identity/credentials: %s', async locale => {
  await render(locale);
  expect(container.textContent).toContain(translate(locale,'humanProof.title'));
  expect(container.textContent).not.toContain('private-account-id');
  expect(container.textContent).not.toContain(scope);
  expect(container.querySelector('img')?.getAttribute('src')).toContain('data:image/png');
  expect(container.querySelector('a[href^="zkproofport:"]')?.getAttribute('href')).toBe(metadata.deepLink);
  expect(fetchMock).toHaveBeenCalledWith(`/api/auth/poll/${requestId}?mode=proof`, expect.objectContaining({credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'}));
  const wire = JSON.stringify(fetchMock.mock.calls);
  expect(wire).not.toContain(scope);
  expect(wire).not.toContain(metadata.deepLink);
  expect(wire).not.toContain('Authorization');
});
it.each(['completed','cancelled','expired','failed'])('shows %s terminal state and stops polling', async status => {
  fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>({status,circuit:circuitType,scopeHash:keccak256(toUtf8Bytes(scope))})});
  await render();
  expect(container.textContent).toContain(translate('en',`humanProof.${status}`));
  const count=fetchMock.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(10000));
  expect(fetchMock).toHaveBeenCalledTimes(count);
  expect(container.querySelector('a[href^="zkproofport:"]')).toBeNull();
});
it('does not claim success for a different verified scope', async () => {
  fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>({status:'completed',circuit:circuitType,scopeHash:'0xwrong'})});
  await render();
  expect(container.textContent).toContain(translate('en','humanProof.failed'));
});
it('lets the user stop only this page monitoring and ignores late completion', async () => {
  let resolve!: (value:unknown)=>void;
  fetchMock.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  await render();
  const button = Array.from(container.querySelectorAll('button')).find(el=>el.textContent===translate('en','humanProof.stop'))!;
  await act(async()=>button.click());
  expect(container.textContent).toContain(translate('en','humanProof.stopped'));
  await act(async()=>{resolve({ok:true,status:200,json:async()=>({status:'completed',circuit:circuitType,scopeHash:keccak256(toUtf8Bytes(scope))})});});
  expect(container.textContent).toContain(translate('en','humanProof.stopped'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('expires a stalled request and retries transient failure without overlapping polls', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockImplementation(()=>new Promise(()=>{}));
  await render();
  await act(async()=>vi.advanceTimersByTimeAsync(2000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async()=>vi.advanceTimersByTimeAsync(17000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(6*60*1000));
  expect(container.textContent).toContain(translate('en','humanProof.expired'));
  const count=fetchMock.mock.calls.length;
  await act(async()=>vi.advanceTimersByTimeAsync(20000));
  expect(fetchMock).toHaveBeenCalledTimes(count);
});
