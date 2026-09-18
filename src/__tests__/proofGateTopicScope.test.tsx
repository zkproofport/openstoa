// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ProofGate from '@/components/ProofGate';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

vi.mock('@/lib/relay', () => ({ createSDK: () => ({ generateQRCode: async () => 'data:image/png;base64,test' }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); vi.unstubAllGlobals(); });
it.each(['proof', 'login'] as const)('requests explicit %s mode and leaves topic scope to authenticated server', async (mode) => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', async (_: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => ({ requestId: 'request', deepLink: 'zkproofport://request' }) };
  });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<I18nProvider initialLocale="en"><ProofGate
    circuitType="oidc_domain_attestation" mode={mode} scope="old-scope" provider="google" domain="example.com"
  /></I18nProvider>));
  expect(bodies).toEqual([{
    circuitType: 'oidc_domain_attestation', mode, provider: 'google', domain: 'example.com',
    ...(mode === 'login' ? { scope: 'old-scope' } : {}),
  }]);
});

it('delivers the completed topic proof and public inputs to the submitting page', async () => {
  vi.useFakeTimers();
  const onProofData = vi.fn();
  const proof = { proof: '0xabc', publicInputs: ['0x01'], circuit: 'coinbase_attestation' };
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    json: async () => url.includes('/poll/') ? { status: 'completed', ...proof } : { requestId: 'request', deepLink: 'zkproofport://request' },
  }));
  root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<I18nProvider initialLocale="en"><ProofGate mode="proof" onProofData={onProofData} /></I18nProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onProofData).toHaveBeenCalledExactlyOnceWith(proof);
  } finally {
    vi.useRealTimers();
  }
});
