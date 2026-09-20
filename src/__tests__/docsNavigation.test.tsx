// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DocsPage from '@/components/docs/DocsPage';
import { DOCS_TOPICS } from '@/lib/docs/navigation';
import { CLI_REFERENCE } from '@/lib/docs/cliReference';
import { translate } from '@/lib/i18n';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
vi.mock('@/components/Header', () => ({ default: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { history.replaceState(null, '', '/docs'); });
describe('subject-based documentation', () => {
  it.each(['en', 'ko'] as const)('explains ZK and MLS privacy with public-chat limits in %s', (locale) => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<I18nProvider initialLocale={locale}><DocsPage /></I18nProvider>));
      const login = host.querySelector('[data-privacy-feature="login"]')!;
      const proof = host.querySelector('[data-privacy-feature="proof"]')!;
      const chat = host.querySelector('[data-privacy-feature="chat"]')!;
      expect(login.textContent).toContain('Google');
      expect(proof.textContent).toContain('Coinbase');
      expect(proof.textContent).toContain('Google Workspace');
      expect(proof.textContent).toContain('Microsoft 365');
      expect(chat.textContent).toContain('Message Layer Security');
      expect(chat.querySelector('a')?.getAttribute('href')).toBe('/docs?topic=chat#chat');
      expect(host.textContent).toContain(locale === 'ko' ? '운영자도 기록을 읽을 수 있습니다' : 'operators can also read those archives');
      expect(host.textContent).toContain(locale === 'ko' ? '계정·토픽·전송 시각' : 'account, topic, and transmission time');
      expect(host.textContent).not.toMatch(/proof login or|증명 로그인 또는/);
    } finally { act(() => root.unmount()); }
  });
  it('opens login directly and follows topic changes and browser history', () => {
    history.replaceState(null, '', '/docs#login');
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<I18nProvider initialLocale="ko"><DocsPage /></I18nProvider>));
      expect(host.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/docs?topic=login#login');
      expect(host.querySelector('main')?.textContent).toContain('OPENSTOA_API_KEY');
      expect(host.querySelector('main')?.textContent).toContain('mcpServers');
      expect(host.querySelector('[data-cli-command]')).toBeNull();
      act(() => { history.pushState(null, '', '/docs#topics'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(host.querySelector('main h1')?.textContent).toBe('토픽');
      expect(host.querySelector('main')?.textContent).not.toContain('mcpServers');
      act(() => { history.replaceState(null, '', '/docs#login'); window.dispatchEvent(new PopStateEvent('popstate')); });
      expect(host.querySelector('main h1')?.textContent).toBe('로그인 · CLI / MCP 연결');
      act(() => { history.replaceState(null, '', '/docs#unknown'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(host.querySelector('main h1')?.textContent).toBe('OpenStoa 소개');
    } finally { act(() => root.unmount()); }
  });
  it.each(['en', 'ko'] as const)('renders every subject with registered %s translations', (locale) => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<I18nProvider initialLocale={locale}><DocsPage /></I18nProvider>));
      for (const item of DOCS_TOPICS) {
        act(() => { history.replaceState(null, '', `/docs#${item.id}`); window.dispatchEvent(new HashChangeEvent('hashchange')); });
        expect(host.querySelector('main h1')?.textContent).toBe(translate(locale, `docs.${item.label}`));
        expect(host.querySelectorAll('main')).toHaveLength(1);
        expect(host.querySelector('main')?.textContent).not.toMatch(/(?:docs|proofs)\.[a-z]|\{\{\w+\}\}/);
        expect(host.querySelectorAll('[data-proof-workflow]')).toHaveLength(['login', 'topics'].includes(item.id) || item.id.startsWith('proof-') ? 1 : 0);
        expect(host.querySelectorAll('[data-proof-guide]')).toHaveLength(item.id.startsWith('proof-') ? 1 : 0);
      }
    } finally { act(() => root.unmount()); }
  });
  it('keeps old deep links and the complete command reference accessible', () => {
    history.replaceState(null, '', '/docs#cli-reference');
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<I18nProvider initialLocale="en"><DocsPage /></I18nProvider>));
      expect(host.querySelectorAll('[data-cli-command]')).toHaveLength(CLI_REFERENCE.length);
      expect(host.querySelector('[data-cli-command="apikey use"]')).not.toBeNull();
      expect(host.querySelector('main h1')?.textContent).toBe('CLI command reference');
    } finally { act(() => root.unmount()); }
  });
});
