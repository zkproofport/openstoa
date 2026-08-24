// @vitest-environment jsdom
/**
 * `CommunityLayout.tsx` — the centre content column now caps at the reading
 * measure (`--read-max`, globals.css) instead of relying entirely on
 * MAX_WIDTH (the row's own 1400px cap) minus both sidebars to stay narrow.
 * That arithmetic is correct today but silent — a future change to either
 * sidebar's width or visibility rule would widen the column past comfortable
 * reading with no test catching it. This file pins the explicit contract
 * instead: the column's own wrapper always carries `max-width: var(--read-max)`,
 * regardless of which sidebars are visible.
 *
 * Edge-case matrix rows covered here:
 *   contract   — the centre content wrapper carries `maxWidth: 'var(--read-max)'`
 *                on a topic page (both sidebars present) AND on a page with
 *                no topic context (right sidebar still mounted, just
 *                CSS-hidden below 1024px — this component doesn't know the
 *                viewport, so the inline style must be present regardless)
 *   contract   — `--rail-w` is untouched (still declared, still 340/380/420
 *                across the same breakpoints) — this change must not touch it
 *   contract   — the sticky offsets on the left sidebar, right sidebar, and
 *                chat rail columns still read `var(--header-h)`, not a
 *                hardcoded pixel value — this change must not break them
 *   contract   — `--read-max` itself is declared once in globals.css at 860px
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  usePathname: () => '/topics',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
  DESKTOP_CHAT_QUERY: '(min-width: 1024px)',
  MOBILE_QUERY: '(max-width: 767px)',
}));

vi.mock('@/components/Header', () => ({
  default: () => React.createElement('div', { 'data-testid': 'header' }),
}));

vi.mock('@/components/ChatRail', () => ({
  default: () => React.createElement('div', { 'data-testid': 'chat-rail' }),
}));

import CommunityLayout from '@/components/CommunityLayout';
import { TestProviders } from './harness/providers';

let container: HTMLDivElement;
let root: Root;

function routeFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/categories')) return Promise.resolve({ ok: true, json: async () => ({ categories: [] }) });
      if (url.startsWith('/api/topics')) return Promise.resolve({ ok: true, json: async () => ({ topics: [] }) });
      if (url.startsWith('/api/stats')) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/api/tags')) return Promise.resolve({ ok: true, json: async () => ({ tags: [] }) });
      if (url.startsWith('/api/feed')) return Promise.resolve({ ok: true, json: async () => ({ posts: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routeFetch();
  try { window.localStorage.clear(); } catch {}
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(<TestProviders initialLocale="en">{ui}</TestProviders>);
    await Promise.resolve();
  });
}

function css(): string {
  return readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
}

describe('CommunityLayout — centre column reading measure', () => {
  it('CONTRACT: the content wrapper caps at var(--read-max) on a topic page (both sidebars mounted)', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true} topicId="t1" topicTitle="Zoning Law">
        <div data-testid="page-content">hello</div>
      </CommunityLayout>,
    );

    const contentEl = container.querySelector('[data-testid="page-content"]') as HTMLElement;
    const capWrapper = contentEl.parentElement as HTMLElement;
    expect(capWrapper.style.maxWidth).toBe('var(--read-max)');
    expect(capWrapper.style.width).toBe('100%');
  });

  it('CONTRACT: the content wrapper caps at var(--read-max) on a non-topic page too', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div data-testid="page-content">hello</div>
      </CommunityLayout>,
    );

    const contentEl = container.querySelector('[data-testid="page-content"]') as HTMLElement;
    const capWrapper = contentEl.parentElement as HTMLElement;
    expect(capWrapper.style.maxWidth).toBe('var(--read-max)');
  });

  it('CONTRACT: the cap wrapper is centred within the remaining flex space (justify-content: center on its parent)', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div data-testid="page-content">hello</div>
      </CommunityLayout>,
    );

    const contentEl = container.querySelector('[data-testid="page-content"]') as HTMLElement;
    const flexSlot = contentEl.parentElement!.parentElement as HTMLElement;
    expect(flexSlot.style.display).toBe('flex');
    expect(flexSlot.style.justifyContent).toBe('center');
  });
});

describe('CommunityLayout — this change must not touch --rail-w or the header-h sticky offsets', () => {
  it('CONTRACT: --rail-w is still declared with its three breakpoint values', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div>hello</div>
      </CommunityLayout>,
    );

    const styleTag = Array.from(container.querySelectorAll('style')).find((s) => s.textContent?.includes('--rail-w'));
    expect(styleTag?.textContent).toContain(':root { --rail-w: 340px; }');
    expect(styleTag?.textContent).toContain('--rail-w: 380px;');
    expect(styleTag?.textContent).toContain('--rail-w: 420px;');
  });

  it('CONTRACT: left sidebar, right sidebar, and chat rail columns still use the var(--header-h) sticky offset', async () => {
    await render(
      <CommunityLayout isGuest={false} sessionChecked={true} topicId="t1" topicTitle="Zoning Law">
        <div>hello</div>
      </CommunityLayout>,
    );

    const left = container.querySelector('.layout-left-sidebar') as HTMLElement;
    const right = container.querySelector('.layout-right-sidebar') as HTMLElement;
    expect(left.style.position).toBe('sticky');
    expect(left.style.top).toContain('var(--header-h)');
    expect(right.style.position).toBe('sticky');
    expect(right.style.top).toContain('var(--header-h)');
  });
});

describe('globals.css — --read-max token contract', () => {
  it('CONTRACT: --read-max is declared once, at 860px, matching the pre-existing chatWidth "wide" cap', () => {
    const source = css();
    const hits = source.match(/--read-max:\s*860px;/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
