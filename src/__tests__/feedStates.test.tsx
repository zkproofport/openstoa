// @vitest-environment jsdom
/**
 * The feed's states must stay DISTINCT states.
 *
 * The defect this guards: a failed `/api/feed` request used to render a bare
 * red bar containing the raw exception text, with the empty state suppressed
 * by a `!error` guard and no way to retry. To a user that is indistinguishable
 * from "there is nothing here" — which the error copy now explicitly denies
 * ("That's different from there being nothing here").
 *
 * Assertions are behavioural, not stylistic: they check WHICH message and
 * WHICH affordance renders, so a future refactor cannot collapse error back
 * into empty, drop the retry, or merge the two empty variants.
 *
 * Rendering follows this repo's convention (`react-dom/client` + `act`), not
 * Testing Library — that package is not a dependency here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => searchParamsMock.current,
}));

// The shell is not under test; render children only so the states are the only
// thing on screen.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('@/components/PostCard', () => ({
  default: ({ post }: { post: { id: string } }) =>
    React.createElement('article', { 'data-testid': 'post' }, post.id),
}));
vi.mock('@/components/Spinner', () => ({
  default: () => React.createElement('div', { 'data-testid': 'spinner' }),
}));

import TopicsPage from '@/app/topics/page';

const SESSION = { userId: '0xabc', nickname: 'tester' };

/** `/api/auth/session` always resolves; `/api/feed` behaves as each test says. */
function mockFetch(feed: () => Response) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/auth/session')) {
      return Promise.resolve(new Response(JSON.stringify(SESSION), { status: 200 }));
    }
    if (url.startsWith('/api/feed')) {
      // A thrown fetch (network down) and a 5xx are different failures; the
      // caller decides which by throwing inside `feed`.
      return Promise.resolve(feed());
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

const jsonFeed = (posts: unknown[]) => new Response(JSON.stringify({ posts }), { status: 200 });

let container: HTMLDivElement;
let root: Root;

/** Mount and flush the session fetch + the feed fetch it triggers. */
async function mount() {
  await act(async () => {
    // Locale pinned to `en` so assertions can compare against en.json directly;
    // the ko side is covered by the shape/translation checks at the bottom.
    root.render(
      <I18nProvider initialLocale="en">
        <TopicsPage />
      </I18nProvider>,
    );
  });
  // Two chained promise generations: session resolve → effect → feed resolve.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent ?? '';
const byRole = (role: string) => Array.from(container.querySelectorAll(`[role="${role}"]`));
const buttons = () => Array.from(container.querySelectorAll('button'));
const buttonNamed = (name: string) => buttons().find((b) => (b.textContent ?? '').includes(name));
const links = () => Array.from(container.querySelectorAll('a'));

async function click(el: Element | undefined) {
  expect(el, 'element to click was not found').toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  searchParamsMock.current = new URLSearchParams();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom has no IntersectionObserver; the infinite-scroll effect constructs one.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('feed states — an error is NOT an empty feed', () => {
  it('CONTRACT: a failed request shows the error copy AND a retry, and never the empty copy', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response('boom', { status: 500 })));
    await mount();

    expect(byRole('alert')).toHaveLength(1);
    expect(text()).toContain(en.feedPage.error.title);
    expect(text()).toContain(en.feedPage.error.body);
    expect(buttonNamed(en.feedPage.error.retry)).toBeTruthy();

    // The whole point: "nothing here" must NOT also be on screen.
    expect(text()).not.toContain(en.feedPage.empty.firstTitle);
    expect(text()).not.toContain(en.feedPage.empty.filteredTitle);
  });

  it('the raw exception message is never shown to the user', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => {
        throw new Error('ECONNREFUSED 10.0.0.1:5432');
      }),
    );
    await mount();

    expect(byRole('alert')).toHaveLength(1);
    expect(text()).not.toContain('ECONNREFUSED');
    expect(text()).not.toContain('10.0.0.1');
  });

  it('retry re-requests the feed and clears the error when it succeeds', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch(() => {
        attempts += 1;
        return attempts === 1 ? new Response('boom', { status: 500 }) : jsonFeed([{ id: 'p1' }]);
      }),
    );
    await mount();
    expect(byRole('alert')).toHaveLength(1);

    await click(buttonNamed(en.feedPage.error.retry));

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(byRole('alert')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="post"]')).toHaveLength(1);
  });
});

describe('feed states — the two empty states are genuinely different', () => {
  it('no posts, no filters → first-use copy pointing OUT to discovery', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonFeed([])));
    await mount();

    expect(text()).toContain(en.feedPage.empty.firstTitle);
    expect(text()).toContain(en.feedPage.empty.firstBody);
    // An outward link, not a filter-clearing button — there is nothing to clear.
    const cta = links().find((a) => (a.textContent ?? '').includes(en.feedPage.empty.firstCta));
    expect(cta?.getAttribute('href')).toBe('/topics/explore');
    expect(text()).not.toContain(en.feedPage.empty.filteredTitle);
  });

  it('no posts WITH a filter → filtered copy and a recovery action', async () => {
    searchParamsMock.current = new URLSearchParams('category=zk');
    vi.stubGlobal('fetch', mockFetch(() => jsonFeed([])));
    await mount();

    expect(text()).toContain(en.feedPage.empty.filteredTitle);
    expect(text()).toContain(en.feedPage.empty.filteredBody);
    expect(text()).not.toContain(en.feedPage.empty.firstTitle);
    expect(buttonNamed(en.feedPage.clearFilters)).toBeTruthy();
  });

  it('a 404 from the feed reads as EMPTY, not as an error', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response('', { status: 404 })));
    await mount();

    expect(byRole('alert')).toHaveLength(0);
    expect(text()).toContain(en.feedPage.empty.firstTitle);
  });
});

describe('feed sort chips', () => {
  it('expose selection via aria-pressed, with exactly one pressed at a time', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonFeed([{ id: 'p1' }])));
    await mount();

    const pressed = () =>
      buttons().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].textContent).toContain(en.feedPage.sort.hot);

    await click(buttonNamed(en.feedPage.sort.top));

    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].textContent).toContain(en.feedPage.sort.top);
  });
});

describe('feedPage i18n', () => {
  const shape = (o: unknown, prefix = ''): string[] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${prefix}${k}.`))
      : [prefix];
  const values = (o: unknown): string[] =>
    typeof o === 'string' ? [o] : Object.values(o as Record<string, unknown>).flatMap(values);

  it('en and ko carry the same key shape', () => {
    expect(shape(ko.feedPage).sort()).toEqual(shape(en.feedPage).sort());
  });

  it('no ko value is blank, and none was left as its English counterpart', () => {
    const koValues = values(ko.feedPage);
    const enValues = values(en.feedPage);
    expect(koValues.filter((v) => v.trim().length === 0)).toEqual([]);
    expect(koValues.filter((v, i) => v === enValues[i])).toEqual([]);
  });
});
