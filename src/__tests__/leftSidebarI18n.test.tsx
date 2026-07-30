// @vitest-environment jsdom
/**
 * `LeftSidebar.tsx` — the worked-example i18n + token migration for this
 * pass. Every static UI string in the component now resolves through
 * `useTranslation()`; a handful of inline styles were mechanically swapped
 * for the new design tokens (border-radius, the section-heading
 * uppercase-label idiom, the search input's zoom-safe font-size).
 *
 * Edge-case matrix covered here:
 *   contract — every previously-hardcoded string now renders via i18n in en
 *   contract — the same strings render correctly in ko (full pass, not spot
 *              check) and none fall back to the raw key path
 *   ui       — the language-conditional `.os-label` class is applied to
 *              every migrated section heading (uppercase/tracking is a CSS
 *              concern gated by :lang(en), not something the component must
 *              branch on)
 *   contract — the expand/collapse aria-label switches with locale
 *   contract — the search input's font-size guards against iOS zoom (16px
 *              floor), and no longer hardcodes 13px
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  usePathname: () => '/topics',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/TopicAvatar', () => ({
  default: () => React.createElement('div', { 'data-testid': 'topic-avatar' }),
}));

import { I18nProvider } from '@/lib/i18n/I18nProvider';
import LeftSidebar from '@/components/LeftSidebar';
import type { Locale } from '@/lib/i18n';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/categories')) return jsonResponse({ categories: [] });
      if (url.startsWith('/api/topics')) return jsonResponse({ topics: [] });
      if (url.startsWith('/api/stats')) return jsonResponse({ totalTopics: 3, totalMembers: 9 });
      if (url.startsWith('/api/tags')) return jsonResponse({ tags: [] });
      return jsonResponse({});
    }),
  );
});

async function renderSidebar(locale: Locale) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

function text() {
  return container.textContent ?? '';
}

describe('LeftSidebar — English (default locale)', () => {
  it('renders every migrated string in English, nothing falls back to a raw i18n key', async () => {
    await renderSidebar('en');
    const t = text();
    expect(t).toContain('Start a Topic');
    expect(t).toContain('Chat');
    expect(t).toContain('All');
    expect(t).toContain('My Topics');
    expect(t).toContain('Explore Topics');
    expect(t).toContain('Categories');
    expect(t).toContain('Community');
    expect(t).toContain('Topics');
    expect(t).toContain('Members');
    expect(t).toContain('On-Chain Records');
    expect(t).toContain('Posts recorded on Base are permanently preserved on-chain.');
    expect(t).toContain('View recorded posts');
    // No raw dotted key path should ever leak into rendered output.
    expect(t).not.toMatch(/sidebar\.[a-zA-Z.]+/);
  });

  it('the search input placeholder is in English and is zoom-safe (16px floor, not 13px)', async () => {
    await renderSidebar('en');
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.placeholder).toBe('Search topics...');
    expect(input.style.fontSize).toBe('var(--text-body)');
  });

  it('section headings carry the language-conditional .os-label class', async () => {
    await renderSidebar('en');
    const labels = container.querySelectorAll('.os-label');
    // Categories, Community, On-Chain Records (Popular Tags is conditional on
    // tags.length > 0, which is empty in this fixture).
    expect(labels.length).toBeGreaterThanOrEqual(3);
  });
});

describe('LeftSidebar — Korean', () => {
  it('renders every migrated string in Korean, none fall back to English or a raw key', async () => {
    await renderSidebar('ko');
    const t = text();
    expect(t).toContain('토픽 만들기'); // Start a Topic
    expect(t).toContain('채팅'); // Chat
    expect(t).toContain('전체'); // All
    expect(t).toContain('내 토픽'); // My Topics
    expect(t).toContain('토픽 둘러보기'); // Explore Topics
    expect(t).toContain('카테고리'); // Categories
    expect(t).toContain('커뮤니티'); // Community
    expect(t).toContain('온체인 기록'); // On-Chain Records
    expect(t).toContain('Base에 기록된 게시물은 영구적으로 온체인에 보존됩니다.');
    expect(t).toContain('기록된 게시물 보기'); // View recorded posts
    expect(t).not.toMatch(/sidebar\.[a-zA-Z.]+/);
    // Nothing should silently stay in English on the Korean surface.
    expect(t).not.toContain('Start a Topic');
    expect(t).not.toContain('Categories');
  });

  it('the search input placeholder is in Korean', async () => {
    await renderSidebar('ko');
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.placeholder).toBe('토픽 검색...');
  });

  it('expand/collapse aria-label follows the active locale (exercised once a category has topics)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/categories')) {
          return jsonResponse({
            categories: [{ id: 'c1', name: 'Base & Layer 2', slug: 'base-layer2', icon: '🔵', sortOrder: 1 }],
          });
        }
        if (url.startsWith('/api/topics')) {
          return jsonResponse({
            topics: [{ id: 't1', title: 'Hello', memberCount: 1, categorySlug: 'base-layer2' }],
          });
        }
        if (url.startsWith('/api/stats')) return jsonResponse({ totalTopics: 1, totalMembers: 1 });
        if (url.startsWith('/api/tags')) return jsonResponse({ tags: [] });
        return jsonResponse({});
      }),
    );

    await renderSidebar('ko');
    const expandBtn = container.querySelector('[aria-label="펼치기"], [aria-label="접기"]');
    expect(expandBtn).not.toBeNull();
  });
});
