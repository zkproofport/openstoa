// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { TestProviders, makeTestQueryClient } from './harness/providers';
import { sessionKeys } from '@/lib/queryKeys';
import BadgeVisibilitySettings from '@/components/BadgeVisibilitySettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let badges: { type: string; visible: boolean; domain?: string }[];
let failSave: boolean;
let failLoad: boolean;
let queryClient: ReturnType<typeof makeTestQueryClient>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = makeTestQueryClient();
  queryClient.setQueryData(sessionKeys.current(), { userId: 'owner', nickname: 'Owner' });
  badges = [{ type: 'kyc', visible: true }, { type: 'oidc_domain', visible: false, domain: 'company.com' }];
  failSave = false;
  failLoad = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (failSave) return new Response('{}', { status: 500 });
      const body = JSON.parse(String(init.body));
      badges = badges.map(b => b.type === body.type ? { ...b, visible: body.visible } : b);
      return Response.json({ success: true, ...body, userId: 'owner', publicBadges: [] });
    }
    if (failLoad) return new Response('{}', { status: 500 });
    return Response.json({ badges, userId: 'owner', publicBadges: [] });
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});
async function render(locale: 'en' | 'ko' = 'en') {
  await act(async () => root.render(<TestProviders initialLocale={locale} queryClient={queryClient}><BadgeVisibilitySettings /></TestProviders>));
}
it('shows owner active and hidden badges, and persists OFF then ON through the API', async () => {
  await render();
  let switches = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
  expect(switches).toHaveLength(2);
  expect(switches[1].getAttribute('aria-label')).toBe('Show company.com badge to others');
  expect(switches[0].getAttribute('aria-checked')).toBe('true');
  expect(switches[1].getAttribute('aria-checked')).toBe('false');
  expect(container.textContent).toContain('company.com');
  await act(async () => switches[0].click());
  expect(badges[0].visible).toBe(false);
  expect(switches[0].getAttribute('aria-checked')).toBe('false');
  await act(async () => switches[0].click());
  expect(badges[0].visible).toBe(true);
});
it('failed save leaves the previous visibility and reports an error in Korean', async () => {
  await render('ko');
  failSave = true;
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/[가-힣]/);
});
it('distinguishes failed loading from no verified badges and allows retry', async () => {
  failLoad = true;
  await render();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('[role="switch"]')).toBeNull();
  failLoad = false;
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
});
it('shows an empty state without controls for an unverified account', async () => {
  badges = [];
  await render('ko');
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).toMatch(/인증/);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
