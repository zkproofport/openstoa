// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import ProofGuide, { type ProofGuideKind } from '@/components/docs/ProofGuide';
import en from '@/lib/i18n/locales/proofs.en.json';
import ko from '@/lib/i18n/locales/proofs.ko.json';

const current = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ko' }));
vi.mock('@/lib/i18n/I18nProvider', () => ({
  useTranslation: () => ({ t: (key: string) => {
    const value = (current.locale === 'ko' ? ko : en)[key.replace('proofs.', '') as keyof typeof en];
    if (value === undefined) throw new Error(`Missing translation: ${key}`);
    return value;
  } }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('subject-specific proof guides', () => {
  it('keeps every proof translation complete in both languages', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ko[key].trim(), key).not.toBe('');
      expect((ko[key].match(/\{\{\w+\}\}/g) ?? []).sort(), key).toEqual((en[key].match(/\{\{\w+\}\}/g) ?? []).sort());
    }
  });

  it.each([
    ['login', 'oidc_domain_attestation', ['/api/docs/openapi.json']],
    ['workspace', 'oidc_domain_attestation', ['/api/docs/proof-guide/google_workspace', '/api/docs/proof-guide/microsoft_365']],
    ['kyc', 'coinbase_attestation', ['/api/docs/proof-guide/kyc']],
    ['country', 'coinbase_country_attestation', ['/api/docs/proof-guide/country']],
  ] as const)('renders only the selected %s subject with stable executable examples and valid references', (kind, circuit, links) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let examples: string[] = [];
    try {
      for (const locale of ['en', 'ko'] as const) {
        current.locale = locale;
        act(() => root.render(<ProofGuide kind={kind as ProofGuideKind} />));
        const dictionary = locale === 'ko' ? ko : en;
        expect(container.querySelector('[data-proof-guide]')?.getAttribute('data-proof-guide')).toBe(kind);
        expect(container.querySelectorAll('h1, header, main')).toHaveLength(0);
        expect(container.querySelector('code')?.textContent).toBe(circuit);
        expect(container.textContent).toContain(dictionary[`${kind}Intro`]);
        for (const other of ['login', 'workspace', 'kyc', 'country'] as const) {
          if (other !== kind) expect(container.textContent).not.toContain(dictionary[`${other}Intro`]);
        }
        expect(container.textContent).not.toMatch(/\{\{\w+\}\}/);
        expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(links);
        const code = [...container.querySelectorAll('pre')].map((pre) => pre.textContent ?? '');
        if (locale === 'en') examples = code;
        else expect(code).toEqual(examples);
        expect(code.join('\n')).not.toContain('zkproofport-prove');
        if (kind === 'login') expect(code.join('\n')).toContain('openstoa --json whoami');
        else {
          expect(code.join('\n')).toContain('--proof "$PROOF"');
          expect(code.join('\n')).toContain('--public-inputs "$PUBLIC_INPUTS"');
        }
      }
    } finally {
      act(() => root.unmount());
      current.locale = 'en';
    }
  });
});
