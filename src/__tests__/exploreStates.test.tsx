// @vitest-environment jsdom
/**
 * Explore's states, controls and card content.
 *
 * The defects this guards, all of them structural rather than cosmetic:
 *
 *   · A failed `/api/topics` request rendered a red bar carrying the raw
 *     exception and nothing to act on. To a reader that is indistinguishable
 *     from "there are no topics" — which the error copy now explicitly denies,
 *     and which a working Retry now makes recoverable.
 *   · The two empty states shared one title ("No topics found"), so
 *     "your category filter excluded everything" and "nothing exists yet" were
 *     the same screen with a different second line.
 *   · Sort selection was a saturated brand fill and carried NO `aria-pressed`,
 *     so the state existed only as a color. It is now `.os-chip` +
 *     `aria-pressed`, identical to the feed's control (`src/app/topics/page.tsx`)
 *     — the two browse surfaces must not disagree about what "selected" looks
 *     like, and a screen reader must be able to hear it at all.
 *   · Every card carried a brand-filled Join, so N cards read as N competing
 *     calls to action. Primary fill is now reserved for the one action in a
 *     state that has exactly one.
 *
 * Rendering follows this repo's convention (`react-dom/client` + `act`), not
 * Testing Library — that package is not a dependency here.
 *
 * Edge-case matrix rows covered here:
 *   boundary   — 0 / 1 / N topics
 *   hostile    — a `<script>`-shaped title/description renders as text
 *   empty      — null / '' / whitespace-only description renders no block
 *   UTF-8      — Korean + emoji titles, descriptions and category names
 *   large      — a 500-char title is clipped by CSS, with the value intact
 *   authz      — guest banner + guest Join routes to sign-in; member → View
 *   race       — a double-clicked Join issues exactly ONE POST
 *   contract   — the category select drives `category=` on the fetch URL
 *   integrity  — error is a DISTINCT state from empty, and carries a retry
 *   i18n       — new keys exist in both locales and are actually translated
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.current,
}));

// The shell is not under test; render children only.
vi.mock('@/components/CommunityLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('@/components/Spinner', () => ({
  default: () => React.createElement('div', { 'data-testid': 'spinner' }),
}));

import ExplorePage from '@/app/topics/explore/page';

const SESSION = { userId: '0xabc', nickname: 'tester' };

interface TopicFixture {
  id: string;
  title: string;
  description?: string | null;
  memberCount?: number;
  proofType?: string;
  isMember?: boolean;
  category?: { id: string; name: string; slug: string; icon: string } | null;
}

function topic(t: TopicFixture) {
  return {
    memberCount: 3,
    proofType: 'none',
    visibility: 'public',
    isMember: false,
    category: null,
    image: null,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...t,
  };
}

const CATEGORIES = [{ id: 'c1', name: 'Privacy', slug: 'privacy', icon: '🛡' }];

let container: HTMLDivElement;
let root: Root;
/** Every URL the component fetched, in order — the contract assertions read it. */
let urls: string[];

/**
 * `/api/auth/session` and `/api/categories` always resolve; `/api/topics`
 * behaves as each test says. Join POSTs resolve 200 unless overridden.
 */
function mockFetch(
  topicsRes: () => Response,
  opts: { session?: unknown; categories?: unknown[]; join?: () => Promise<Response> } = {},
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/auth/session')) {
      return Promise.resolve(new Response(JSON.stringify(opts.session ?? SESSION), { status: 200 }));
    }
    if (url.startsWith('/api/categories')) {
      return Promise.resolve(
        new Response(JSON.stringify({ categories: opts.categories ?? CATEGORIES }), { status: 200 }),
      );
    }
    if (init?.method === 'POST') {
      return opts.join ? opts.join() : Promise.resolve(new Response('{}', { status: 200 }));
    }
    if (url.startsWith('/api/topics')) return Promise.resolve(topicsRes());
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

const jsonTopics = (topics: unknown[]) =>
  new Response(JSON.stringify({ topics }), { status: 200 });

async function mount(locale: 'en' | 'ko' = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <ExplorePage />
      </I18nProvider>,
    );
  });
  // Chained generations: session resolve → effect → topics resolve.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent ?? '';
const cards = () => Array.from(container.querySelectorAll('[data-testid="topic-card"]'));
const buttons = () => Array.from(container.querySelectorAll('button'));
const links = () => Array.from(container.querySelectorAll('a'));
const buttonNamed = (name: string) => buttons().find((b) => (b.textContent ?? '').includes(name));
const byRole = (role: string) => Array.from(container.querySelectorAll(`[role="${role}"]`));

async function click(el: Element | undefined) {
  expect(el, 'element to click was not found').toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  urls = [];
  searchParamsMock.current = new URLSearchParams();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

// ── States ───────────────────────────────────────────────────────────────────

describe('explore states — an error is NOT an empty list', () => {
  it('CONTRACT: a 500 shows the error copy AND a retry, and never the empty copy', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response('boom', { status: 500 })));
    await mount();

    expect(byRole('alert')).toHaveLength(1);
    expect(text()).toContain(en.explorePage.loadFailed);
    expect(text()).toContain(en.explorePage.errorBody);
    expect(buttonNamed(en.common.retry)).toBeTruthy();

    expect(text()).not.toContain(en.explorePage.noTopicsFound);
    expect(text()).not.toContain(en.explorePage.noTopicsMatchFilter);
    expect(cards()).toHaveLength(0);
  });

  it('the raw exception message is never shown to the user', async () => {
    vi.stubGlobal('fetch', mockFetch(() => { throw new Error('ECONNREFUSED 10.0.0.1:5432'); }));
    await mount();

    expect(byRole('alert')).toHaveLength(1);
    expect(text()).not.toContain('ECONNREFUSED');
    expect(text()).not.toContain('10.0.0.1');
  });

  it('retry re-requests and clears the error when it succeeds', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', mockFetch(() => {
      attempts += 1;
      return attempts === 1
        ? new Response('boom', { status: 500 })
        : jsonTopics([topic({ id: 't1', title: 'Privacy' })]);
    }));
    await mount();
    expect(byRole('alert')).toHaveLength(1);

    await click(buttonNamed(en.common.retry));

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(byRole('alert')).toHaveLength(0);
    expect(cards()).toHaveLength(1);
  });
});

describe('explore states — the two empty states are genuinely different', () => {
  it('BOUNDARY 0, no filter → first-use copy, and no dead Clear-filter button', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([])));
    await mount();

    expect(text()).toContain(en.explorePage.noTopicsFound);
    expect(text()).toContain(en.explorePage.beFirstToCreate);
    expect(text()).not.toContain(en.explorePage.noTopicsMatchFilter);
    expect(buttonNamed(en.explorePage.clearFilter)).toBeUndefined();
  });

  it('BOUNDARY 0, WITH a category filter → filtered copy and a recovery action', async () => {
    searchParamsMock.current = new URLSearchParams('category=privacy');
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([])));
    await mount();

    expect(text()).toContain(en.explorePage.noTopicsMatchFilter);
    expect(text()).toContain(en.explorePage.tryDifferentCategory);
    expect(text()).not.toContain(en.explorePage.noTopicsFound);
    expect(buttonNamed(en.explorePage.clearFilter)).toBeTruthy();
  });

  it('clearing the filter re-requests WITHOUT the category param', async () => {
    searchParamsMock.current = new URLSearchParams('category=privacy');
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([])));
    await mount();
    expect(urls.some((u) => u.includes('category=privacy'))).toBe(true);

    urls = [];
    await click(buttonNamed(en.explorePage.clearFilter));

    const topicCalls = urls.filter((u) => u.startsWith('/api/topics'));
    expect(topicCalls.length).toBeGreaterThan(0);
    expect(topicCalls.every((u) => !u.includes('category='))).toBe(true);
  });

  it('BOUNDARY 1 / N: one and many topics each render one card apiece', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([topic({ id: 't1', title: 'One' })])));
    await mount();
    expect(cards()).toHaveLength(1);

    act(() => root.unmount());
    root = createRoot(container);
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'One' }),
      topic({ id: 't2', title: 'Two' }),
      topic({ id: 't3', title: 'Three' }),
    ])));
    await mount();
    expect(cards()).toHaveLength(3);
  });
});

// ── Controls ─────────────────────────────────────────────────────────────────

describe('explore sort chips — the feed page control, verbatim', () => {
  it('expose selection via aria-pressed, with exactly one pressed at a time', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([topic({ id: 't1', title: 'One' })])));
    await mount();

    const pressed = () => buttons().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].textContent).toContain(en.explorePage.sort.hot);

    await click(buttonNamed(en.explorePage.sort.top));

    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].textContent).toContain(en.explorePage.sort.top);
  });

  it('selection is QUIET — the chip class, never an inline saturated brand fill', async () => {
    // A row of brand-filled chips above the grid shouts louder than the topics.
    // `.os-chip[aria-pressed=true]` in globals.css is the raised treatment; an
    // inline `background: var(--accent)` would be the old loud one coming back.
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([topic({ id: 't1', title: 'One' })])));
    await mount();

    const chips = buttons().filter((b) => b.getAttribute('aria-pressed') !== null);
    expect(chips.length).toBe(4);
    for (const chip of chips) {
      expect(chip.className).toContain('os-chip');
      expect(chip.getAttribute('style') ?? '').not.toContain('--accent');
      expect(chip.getAttribute('style') ?? '').not.toContain('--color-brand-primary');
    }
  });

  it('the category select is the shared select treatment and drives the request', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([])));
    await mount();

    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    // `.os-locale-select` carries the 44px height and the 16px font size that
    // keeps iOS Safari from zooming the page when the select takes focus.
    expect(select.className).toContain('os-locale-select');
    expect(select.getAttribute('aria-label')).toBe(en.explorePage.allCategories);

    urls = [];
    await act(async () => {
      select.value = 'privacy';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(urls.some((u) => u.startsWith('/api/topics') && u.includes('category=privacy'))).toBe(true);
  });

  it('no select is rendered when the category list is empty (nothing to filter by)', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([]), { categories: [] }));
    await mount();

    expect(container.querySelector('select')).toBeNull();
  });
});

// ── Card content ─────────────────────────────────────────────────────────────

describe('explore cards — content integrity', () => {
  it('HOSTILE: a script-shaped title and description render as text, never as elements', async () => {
    const title = '<script>alert(1)</script>%_\\';
    const description = '<img src=x onerror=alert(2)>';
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([topic({ id: 't1', title, description })])));
    await mount();

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(text()).toContain(title);
    expect(text()).toContain(description);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
  ])('EMPTY: a %s description renders no description block', async (_label, description) => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'Quiet', description }),
    ])));
    await mount();

    expect(cards()).toHaveLength(1);
    expect(cards()[0].querySelectorAll('p')).toHaveLength(0);
  });

  it('UTF-8: Korean, emoji and mixed-script titles/descriptions/categories survive', async () => {
    const title = '프라이버시 🛡 zk';
    const description = '영지식 증명 토론 🇰🇷';
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({
        id: 't1',
        title,
        description,
        category: { id: 'c1', name: '보안 🔐', slug: 'sec', icon: '🛡' },
      }),
    ])));
    await mount();

    expect(text()).toContain(title);
    expect(text()).toContain(description);
    expect(text()).toContain('보안 🔐');
  });

  it('LARGE: a 500-character title is clipped by CSS, with the value intact in the DOM', async () => {
    const title = '가'.repeat(500);
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([topic({ id: 't1', title })])));
    await mount();

    const label = container.querySelector('[data-testid="topic-card-title"]') as HTMLElement;
    expect(label.textContent).toBe(title);
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.overflow).toBe('hidden');
  });

  it('the proof requirement is a quiet outline, not a second call to action', async () => {
    // It states a fact about the topic. Painting it in the brand made it
    // compete with Join, which is the only thing on the card to act on.
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'Gated', proofType: 'kyc' }),
    ])));
    await mount();

    const badge = Array.from(cards()[0].querySelectorAll('span')).find(
      (s) => s.textContent === en.explorePage.proofBadge.kyc,
    ) as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.style.background).toBe('transparent');
    expect(badge.style.color).toContain('--color-text-tertiary');
  });
});

// ── Actions / authorization ──────────────────────────────────────────────────

describe('explore actions', () => {
  it('AUTHZ member: a joined topic offers View (a link), not Join', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'Mine', isMember: true }),
    ])));
    await mount();

    expect(buttonNamed(en.explorePage.join)).toBeUndefined();
    const view = links().find((a) => (a.textContent ?? '').includes(en.explorePage.view));
    expect(view?.getAttribute('href')).toBe('/topics/t1');
  });

  it('the Join action is the QUIET button — primary fill is not repeated per card', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'A' }),
      topic({ id: 't2', title: 'B' }),
    ])));
    await mount();

    const joins = buttons().filter((b) => (b.textContent ?? '').includes(en.explorePage.join));
    expect(joins).toHaveLength(2);
    for (const j of joins) {
      expect(j.className).toContain('os-button');
      expect(j.className).not.toContain('os-button-primary');
    }
  });

  it('AUTHZ guest: the banner shows and Join sends the guest to sign in, never POSTing', async () => {
    vi.stubGlobal('fetch', mockFetch(
      () => jsonTopics([topic({ id: 't1', title: 'Open' })]),
      { session: {} },
    ));
    await mount();

    expect(text()).toContain(en.explorePage.guestBanner);

    urls = [];
    await click(buttonNamed(en.explorePage.join));

    expect(routerMock.push).toHaveBeenCalledWith('/');
    expect(urls.filter((u) => u.includes('/join'))).toHaveLength(0);
  });

  it('RACE: a double-clicked Join issues exactly ONE POST', async () => {
    let resolveJoin: (r: Response) => void = () => {};
    const pending = new Promise<Response>((res) => { resolveJoin = res; });
    const fetchMock = mockFetch(
      () => jsonTopics([topic({ id: 't1', title: 'Open' })]),
      { join: () => pending },
    );
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    const join = buttonNamed(en.explorePage.join)!;
    await act(async () => {
      join.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      join.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);

    await act(async () => { resolveJoin(new Response('{}', { status: 200 })); await pending; });
  });

  it('a successful join flips the card to View and bumps the member count', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonTopics([
      topic({ id: 't1', title: 'Open', memberCount: 3 }),
    ])));
    await mount();
    expect(text()).toContain(`3 ${en.rightSidebar.members}`);

    await click(buttonNamed(en.explorePage.join));

    expect(buttonNamed(en.explorePage.join)).toBeUndefined();
    expect(text()).toContain(`4 ${en.rightSidebar.members}`);
  });
});

// ── i18n ─────────────────────────────────────────────────────────────────────

describe('explorePage i18n', () => {
  const shape = (o: unknown, prefix = ''): string[] =>
    typeof o === 'object' && o !== null
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${prefix}${k}.`))
      : [prefix];

  it('en and ko carry the same key shape', () => {
    expect(shape(ko.explorePage).sort()).toEqual(shape(en.explorePage).sort());
  });

  it('the new keys exist in both locales and ko is actually translated', () => {
    for (const key of ['errorBody', 'noTopicsMatchFilter'] as const) {
      expect(en.explorePage[key].trim().length).toBeGreaterThan(0);
      expect(ko.explorePage[key].trim().length).toBeGreaterThan(0);
      expect(ko.explorePage[key]).not.toBe(en.explorePage[key]);
    }
  });

  it('renders the Korean error copy under the ko locale', async () => {
    vi.stubGlobal('fetch', mockFetch(() => new Response('boom', { status: 500 })));
    await mount('ko');

    expect(text()).toContain(ko.explorePage.errorBody);
    expect(text()).not.toContain(en.explorePage.errorBody);
  });
});
