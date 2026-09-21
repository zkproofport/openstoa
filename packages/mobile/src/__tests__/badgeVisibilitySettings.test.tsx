import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { QueryClient } from '@tanstack/react-query';
import { useOpenStoaSession } from '../stores/sessionStore';
import { BadgeVisibilitySettings } from '../components/BadgeVisibilitySettings';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import en from '../i18n/locales/en.json';
import ko from '../i18n/locales/ko.json';
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../hooks/useOpenStoaClient', () => ({ useOpenStoaClient: () => api }));
afterEach(() => { vi.resetAllMocks(); useOpenStoaSession.getState().clear(); });
async function mount(locale: 'en' | 'ko', fails = false) {
  useOpenStoaSession.getState().setSession({ token: 'token', userId: 'owner' });
  let badges = [
    { type: 'kyc', visible: true, verifiedAt: 1, expiresAt: 9999999999999 },
    {
      type: 'oidc_domain',
      visible: false,
      domain: 'example.com',
      verifiedAt: 1,
      expiresAt: 9999999999999,
    },
  ];
  const publicBadges = () => badges.filter(b => b.visible).map(b => ({ type: b.type === 'oidc_domain' ? 'workspace' : b.type, label: b.domain ?? 'KYC', ...(b.domain ? { domain: b.domain } : {}) }));
  api.get.mockImplementation(async () => ({ userId: 'owner', publicBadges: publicBadges(), badges }));
  api.patch.mockImplementation(async (_path, body) => {
    if (fails) throw new Error('Unable to save');
    badges = badges.map((badge) =>
      badge.type === body.type ? { ...badge, visible: body.visible } : badge,
    );
    return { success: true, userId: 'owner', publicBadges: publicBadges(), ...body };
  });
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: 'en',
    resources: { en: { translation: en }, ko: { translation: ko } },
    interpolation: { escapeValue: false },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const result = await renderScreen(
    <I18nextProvider i18n={i18n}>
      <BadgeVisibilitySettings />
    </I18nextProvider>,
    { queryClient },
  );
  return { ...result, invalidate };
}
describe('mobile badge visibility controls', () => {
  it.each(['en', 'ko'] as const)(
    'hides a verified badge and shows a hidden domain in %s',
    async (locale) => {
      const { rendered, invalidate } = await mount(locale);
      try {
        const hide =
          locale === 'ko'
            ? '신원 인증 배지 숨기기'
            : 'Hide KYC verification badge';
        for (let i = 0; i < 30 && !rendered.pressableWith(hide); i++)
          await flush(2);
        expect(rendered.text()).toContain('example.com');
        const button = rendered.pressableWith(hide);
        expect(button).toBeDefined();
        expect(button?.props.accessibilityState.checked).toBe(true);
        await rendered.press(button!);
        for (
          let i = 0;
          i < 30 &&
          !rendered.pressableWith(
            locale === 'ko'
              ? '신원 인증 배지 공개'
              : 'Show KYC verification badge',
          );
          i++
        )
          await flush(2);
        expect(api.patch).toHaveBeenCalledWith('/api/profile/badges', {
          type: 'kyc',
          visible: false,
        });
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: ['profile', 'domain-badge'],
        });
        const showDomain =
          locale === 'ko'
            ? '워크스페이스 인증 배지 공개'
            : 'Show Organization domain badge';
        await rendered.press(rendered.pressableWith(showDomain)!);
        expect(api.patch).toHaveBeenLastCalledWith('/api/profile/badges', {
          type: 'oidc_domain',
          visible: true,
        });
      } finally {
        rendered.unmount();
      }
    },
  );
  it('disables controls until a pending save has completed', async () => {
    const { rendered } = await mount('en');
    let finish!: (value: unknown) => void;
    api.patch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      for (let i = 0; i < 30 && !rendered.pressableWith('Hide KYC verification badge'); i++) await flush(2);
      await rendered.press(rendered.pressableWith('Hide KYC verification badge')!);
      for (let i = 0; i < 30 && !rendered.pressableWith('Hide KYC verification badge')?.props.disabled; i++) await flush(2);
      expect(rendered.pressableWith('Hide KYC verification badge')?.props.disabled).toBe(true);
      expect(rendered.pressableWith('Show Organization domain badge')?.props.disabled).toBe(true);
      finish({ success: true, userId: 'owner', publicBadges: [], type: 'kyc', visible: false });
      await flush(4);
      expect(api.patch).toHaveBeenCalledTimes(1);
    } finally { rendered.unmount(); }
  });

  it('keeps confirmed visibility when saving fails and reports the failure', async () => {
    const { rendered, host } = await mount('en', true);
    try {
      for (
        let i = 0;
        i < 30 && !rendered.pressableWith('Hide KYC verification badge');
        i++
      )
        await flush(2);
      await rendered.press(
        rendered.pressableWith('Hide KYC verification badge')!,
      );
      await flush(4);
      expect(
        rendered.pressableWith('Hide KYC verification badge')?.props
          .accessibilityState.checked,
      ).toBe(true);
      expect(host.errors.length).toBeGreaterThan(0);
    } finally {
      rendered.unmount();
    }
  });
});

import { act } from 'react-test-renderer';
import { identityBadgesKey } from '../lib/identityBadges';
it('a delayed old GET and session response cannot restore ON after an OFF save', async () => {
  const { rendered, queryClient } = await mount('en');
  const oldBadge = { type: 'kyc', visible: true, verifiedAt: 1, expiresAt: 9999999999999 };
  const publicBadges = [{ type: 'kyc', label: 'KYC' }];
  try {
    for (let i = 0; i < 30 && !rendered.pressableWith('Hide KYC verification badge'); i++) await flush(2);
    queryClient.setQueryData(['session'], { userId: 'owner', nickname: 'Alice', verifiedAt: 1, badges: publicBadges });
    let resolveSession!: (value: unknown) => void;
    const oldSession = queryClient.fetchQuery({ queryKey: ['session'], queryFn: () => new Promise(resolve => { resolveSession = resolve; }), staleTime: 0 }).catch(() => undefined);
    let resolveBadges!: (value: unknown) => void;
    api.get.mockImplementationOnce(() => new Promise(resolve => { resolveBadges = resolve; }));
    const oldGet = queryClient.refetchQueries({ queryKey: ['profile', 'badges', 'owner'] }).catch(() => undefined);
    for (let i = 0; i < 30 && (!resolveBadges || !resolveSession); i++) await flush(2);
    expect(resolveBadges).toBeDefined();
    expect(resolveSession).toBeDefined();
    await rendered.press(rendered.pressableWith('Hide KYC verification badge')!);
    for (let i = 0; i < 30 && !rendered.pressableWith('Show KYC verification badge'); i++) await flush(2);
    await act(async () => {
      resolveBadges({ userId: 'owner', publicBadges, badges: [oldBadge] });
      resolveSession({ userId: 'owner', nickname: 'Alice', verifiedAt: 1, badges: publicBadges });
      await Promise.all([oldGet, oldSession]);
    });
    await flush(4);
    expect(rendered.pressableWith('Show KYC verification badge')?.props.accessibilityState.checked).toBe(false);
    expect(queryClient.getQueryData(identityBadgesKey('owner'))).toEqual([]);
    expect(queryClient.getQueryData<{ badges: unknown[] }>(['session'])?.badges).toEqual([]);
  } finally { rendered.unmount(); }
});

it('an old-account save cannot repopulate cleared caches after switching accounts', async () => {
  const { rendered, queryClient } = await mount('en');
  let finish!: (value: unknown) => void;
  try {
    for (let i = 0; i < 30 && !rendered.pressableWith('Hide KYC verification badge'); i++) await flush(2);
    api.patch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await rendered.press(rendered.pressableWith('Hide KYC verification badge')!);
    for (let i = 0; i < 30 && !finish; i++) await flush(2);
    await act(async () => {
      useOpenStoaSession.getState().setSession({ token: 'other-token', userId: 'other' });
      queryClient.clear();
      api.get.mockResolvedValue({ userId: 'other', publicBadges: [], badges: [] });
      finish({ success: true, userId: 'owner', publicBadges: [], type: 'kyc', visible: false });
    });
    await flush(4);
    expect(queryClient.getQueryData(identityBadgesKey('owner'))).toBeUndefined();
    expect(queryClient.getQueryData(['profile', 'badges', 'owner'])).toBeUndefined();
    expect(rendered.text()).not.toContain('example.com');
  } finally { rendered.unmount(); }
});
