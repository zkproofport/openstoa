// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useTranslation } from '@/lib/i18n/I18nProvider';
import { translate, type Locale } from '@/lib/i18n';
import Badge from '@/components/Badge';
import LandingPage from '@/app/page';
import BookmarkButton from '@/components/post/BookmarkButton';
import PostActionBar from '@/components/post/PostActionBar';
import { categoryLabel } from '@/lib/categoryLabel';
import { cmdLabel, validateApiKeyName } from '@/lib/apiKeyForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ProofGate', () => ({ default: () => null }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', () => ({ apiFetch }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function markup(node: React.ReactNode, locale: Locale) {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  apiFetch.mockReset();
});

describe('web locale omissions', () => {
  it.each(['en', 'ko'] as const)('main login screen exposes Docs before either login flow in %s', (locale) => {
    const doc = new DOMParser().parseFromString(markup(<LandingPage />, locale), 'text/html');
    const links = [...doc.querySelectorAll('a[href="/docs"]')];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe(translate(locale, 'webUi.docs'));
    for (const link of [links[0], doc.querySelector('a[href="/docs?topic=login#login"]')!]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    }
    expect(links[0].classList.contains('desktop-docs-link')).toBe(false);
    expect(links[0].closest('nav')?.getAttribute('aria-label')).toBe(translate(locale, 'landingPage.center.navigation'));
    for (const badge of ['zkProof', 'noDataStored', 'onChainVerified']) {
      expect([...doc.querySelectorAll('.os-human-content span')].map(span => span.textContent)).not.toContain(translate(locale, `landingPage.human.badges.${badge}`));
    }
    expect((doc.querySelector('.os-human-content h2') as HTMLElement).style.fontFamily).toBe('var(--font-sans)');
    const android = doc.querySelector('a[href*="play.google.com/store/apps/details"]');
    expect(android?.getAttribute('href')).toBe('https://play.google.com/store/apps/details?id=com.masselabs.zkproofport&hl=ko');
    expect(android?.textContent?.trim()).toBe(translate(locale, 'landingPage.proving.androidDownload'));
    expect(android?.getAttribute('target')).toBe('_blank');
    expect(doc.body.textContent).toContain(translate(locale, 'landingPage.proving.installStatus'));
  });

  it('collects email for iOS only and keeps the Android download available during login', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    apiFetch.mockResolvedValue({ ok: true });
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root!.render(<I18nProvider initialLocale="en"><LandingPage /></I18nProvider>));
    const button = (key: string) => [...container!.querySelectorAll('button')].find(b => b.textContent?.trim() === translate('en', key))!;
    await act(async () => button('landingPage.human.cta').click());
    expect(container.querySelectorAll('a[href*="play.google.com/store/apps/details"]')).toHaveLength(2);
    await act(async () => button('landingPage.proving.iosSignup').click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(translate('en', 'landingPage.beta.intro'));
    expect(dialog.textContent).not.toContain('Android');
    const email = dialog.querySelector('input[type="email"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(email, 'reader@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('landingPage.beta.requestInvite').click());
    expect(apiFetch).toHaveBeenCalledWith('/api/beta-signup', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'reader@example.com', organization: '', platform: 'iOS' }),
    }));
    expect(dialog.textContent).toContain(translate('en', 'landingPage.beta.successMessage'));
  });

  it('lets a signed-out visitor switch the landing page language and persists their choice', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<I18nProvider initialLocale="ko"><LandingPage /></I18nProvider>));
    const picker = container.querySelector('select');
    expect(picker).not.toBeNull();
    expect(picker?.getAttribute('aria-label')).toBe('언어');
    expect(container.querySelector('.os-human-content h2')?.textContent?.replace(/\s+/g, ' ')).toBe('개인정보는 지키면서 자유롭게 이야기하세요.');
    act(() => { picker!.value = 'en'; picker!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('.os-human-content h2')?.textContent).toBe(translate('en', 'landingPage.human.headline'));
    expect(container.querySelector('a[href="/docs"]')?.textContent).toBe('Docs');
    expect(picker?.getAttribute('aria-label')).toBe('Language');
    expect(document.cookie).toContain('NEXT_LOCALE=en');
    expect(document.documentElement.lang).toBe('en');
    act(() => { picker!.value = 'ko'; picker!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('a[href="/docs"]')?.textContent).toBe('문서 보기');
    expect(document.cookie).toContain('NEXT_LOCALE=ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('clears already-typed text when language changes instead of mixing languages', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<I18nProvider initialLocale="en"><LandingPage /></I18nProvider>));
    for (let i = 0; i < 100; i++) act(() => { vi.advanceTimersByTime(30); });
    expect(container.querySelector('.os-agent-content')?.textContent).toContain(translate('en', 'landingPage.agent.ownerIssuedKeyHint'));
    const picker = container.querySelector('select')!;
    act(() => { picker.value = 'ko'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('.os-agent-content')?.textContent).not.toContain(translate('en', 'landingPage.agent.ownerIssuedKeyHint'));
    for (let i = 0; i < 100; i++) act(() => { vi.advanceTimersByTime(30); });
    expect(container.querySelector('.os-agent-content')?.textContent).toContain(translate('ko', 'landingPage.agent.ownerIssuedKeyHint'));
  });

  it('server-provided English proof labels do not override Korean, while public values survive', () => {
    const doc = new DOMParser().parseFromString(markup(<>
      <Badge type="kyc" label="KYC" />
      <Badge type="country" label="Country" />
      <Badge type="oidc" label="OIDC" />
      <Badge type="workspace" label="Org" />
      <Badge type="workspace" label="Org" domain="example.org" />
      <Badge type="country" label="Country" country="KR" />
      <Badge type="future-display-type" label="Custom label" />
    </>, 'ko'), 'text/html');
    expect([...doc.querySelectorAll('[data-badge-type]')].map(n => n.textContent?.replace('✓', '')))
      .toEqual(['신원 인증', '국가 인증', '로그인 인증', '워크스페이스 인증', 'example.org', 'KR', 'Custom label']);
  });

  it('existing badges update immediately when the viewer changes language', () => {
    function Probe() {
      const { setLocale } = useTranslation();
      return <><Badge type="workspace" label="Org" /><button onClick={() => setLocale('ko')}>switch</button></>;
    }
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<I18nProvider initialLocale="en"><Probe /></I18nProvider>));
    expect(container.textContent).toContain('Org verified');
    act(() => container!.querySelector('button')!.click());
    expect(container.textContent).toContain('워크스페이스 인증');
    expect(container.textContent).not.toContain('Org verified');
  });

  it.each([false, true])('bookmark accessible name is localized (bookmarked=%s)', (bookmarked) => {
    const doc = new DOMParser().parseFromString(markup(<BookmarkButton postId="post" bookmarked={bookmarked} />, 'ko'), 'text/html');
    expect(doc.querySelector('button')?.getAttribute('aria-label')).toBe(bookmarked ? '북마크 해제' : '북마크');
  });

  it('record confirmation and completed state are Korean on the actual action path', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ record: { recordCount: 1 } }) });
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root!.render(<I18nProvider initialLocale="ko"><PostActionBar
      postId="post" href="/topics/topic/posts/post" upvoteCount={0} authorId="author"
      sessionUserId="viewer" userRecorded={false} recordCount={7} bookmarked={false}
    /></I18nProvider>));
    const recordButton = [...container.querySelectorAll('button')].find(b => b.textContent === '7');
    expect(recordButton).toBeDefined();
    await act(async () => recordButton!.click());
    expect(confirm).toHaveBeenCalledWith(translate('ko', 'webUi.recordConfirm'));
    expect(container.textContent).toContain('기록됨');
    expect(apiFetch).toHaveBeenCalledWith('/api/posts/post/record', { method: 'POST' });
  });

  it('localizes built-in categories and known API permissions but preserves custom data', () => {
    const t = (key: string, params?: Record<string, string | number>) => translate('ko', key, params);
    expect(categoryLabel({ slug: 'development', name: 'Development' }, t)).toBe('개발');
    expect(categoryLabel({ slug: 'custom', name: 'My community' }, t)).toBe('My community');
    expect(cmdLabel('/openstoa/post/read', t)).toBe('게시물 읽기');
    expect(cmdLabel('/future/capability', t)).toBe('/future/capability');
    expect(validateApiKeyName(' ', t)).toBe('이름을 입력하세요');
    expect(validateApiKeyName('가'.repeat(101), t)).toBe('이름은 100자 이하여야 합니다');
    expect(validateApiKeyName('가'.repeat(100), t)).toBeNull();
  });
});
