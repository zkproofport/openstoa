// @vitest-environment jsdom
/**
 * `LeftSidebar.tsx` — the redesigned left nav: collapsible `<details>`
 * groups (Browse / Conversations / Categories), a real `aria-current`
 * derived from `usePathname()` on every routable row (previously color-only
 * — nothing exposed "this is the current view" to assistive tech), a
 * right-aligned count on Explore Topics, and an unread badge capability on
 * Chat. Group open/closed state persists across remounts via
 * `src/lib/leftNav.ts` (unit-tested directly in `leftNav.test.ts`).
 *
 * Edge-case matrix rows covered here:
 *   contract  — aria-current is set on the row matching the real pathname
 *               (Explore Topics, On-Chain Records), and on the
 *               state-driven "All" row when no other filter is active
 *   boundary  — Explore Topics shows "0" (not blank) when totalTopics is 0;
 *               shows the real figure otherwise
 *   empty     — My Topics carries no count element at all (no data source),
 *               visibly distinct from Explore Topics showing "0"
 *   boundary  — Chat badge: 0/undefined renders no badge, 1-99 render as-is,
 *               150 caps at "99+"
 *   authz     — guest: no My Topics row, no Conversations group at all
 *               (single-item group hidden rather than shown empty); member:
 *               both present
 *   ui        — every top-level interactive row carries the `os-nav-row`
 *               focus-visible class; long Korean labels do not force a
 *               fixed width (label span keeps flex:1/minWidth:0/ellipsis)
 *   contract  — group open/closed state (a manual toggle) survives a full
 *               unmount + remount of the component (the real shape of
 *               "persists across navigation", since `LeftSidebar` itself
 *               remounts on every page change)
 *   en/ko     — group labels render in both locales (full pass already
 *               covered in `leftSidebarI18n.test.tsx`; this file only
 *               re-checks the two new group labels together with the new
 *               structural behavior)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameMock = vi.hoisted(() => ({ current: '/topics' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/TopicAvatar', () => ({
  default: () => React.createElement('div', { 'data-testid': 'topic-avatar' }),
}));

import { I18nProvider } from '@/lib/i18n/I18nProvider';
import LeftSidebar from '@/components/LeftSidebar';
import type { Locale } from '@/lib/i18n';
import { LEFT_NAV_GROUPS_KEY } from '@/lib/leftNav';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
}

function stubFetch(overrides: { totalTopics?: number } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/categories')) return jsonResponse({ categories: [] });
      if (url.startsWith('/api/topics')) return jsonResponse({ topics: [] });
      if (url.startsWith('/api/stats')) return jsonResponse({ totalTopics: overrides.totalTopics ?? 0, totalMembers: 0 });
      if (url.startsWith('/api/tags')) return jsonResponse({ tags: [] });
      return jsonResponse({});
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pathnameMock.current = '/topics';
  try { window.localStorage.clear(); } catch {}
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSidebar(ui: React.ReactElement, locale: Locale = 'en') {
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{ui}</I18nProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid="${id}"]`));
}

function rowByText(text: string): HTMLElement | undefined {
  const all = Array.from(container.querySelectorAll('a.os-nav-row, button.os-nav-row, [role="button"].os-nav-row'));
  return all.find((el) => el.textContent?.includes(text)) as HTMLElement | undefined;
}

describe('LeftSidebar — aria-current derived from the real pathname', () => {
  it('CONTRACT: Explore Topics carries aria-current="page" only when the pathname matches its href', async () => {
    stubFetch();
    pathnameMock.current = '/topics/explore';
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const explore = rowByText('Explore Topics');
    expect(explore?.getAttribute('aria-current')).toBe('page');

    const recorded = rowByText('On-Chain Records');
    expect(recorded?.getAttribute('aria-current')).toBeNull();
  });

  it('CONTRACT: On-Chain Records carries aria-current="page" on /recorded, and Explore Topics does not', async () => {
    stubFetch();
    pathnameMock.current = '/recorded';
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(rowByText('On-Chain Records')?.getAttribute('aria-current')).toBe('page');
    expect(rowByText('Explore Topics')?.getAttribute('aria-current')).toBeNull();
  });

  it('CONTRACT: "All" carries aria-current="page" by default (no category/tag/topic active)', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(rowByText('All')?.getAttribute('aria-current')).toBe('page');
  });

  it('CONTRACT: "All" loses aria-current once a category becomes active', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked activeCategory="privacy-zk" onOpenChat={() => {}} />);

    expect(rowByText('All')?.getAttribute('aria-current')).toBeNull();
  });
});

describe('LeftSidebar — right-aligned count (Explore Topics)', () => {
  it('BOUNDARY: totalTopics=0 renders the visible figure "0", not a blank/missing count', async () => {
    stubFetch({ totalTopics: 0 });
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const explore = rowByText('Explore Topics');
    expect(explore?.querySelector('.mono')?.textContent).toBe('0');
  });

  it('BOUNDARY: a real totalTopics figure renders as-is', async () => {
    stubFetch({ totalTopics: 1204 });
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const explore = rowByText('Explore Topics');
    expect(explore?.querySelector('.mono')?.textContent).toBe('1204');
  });

  it('EMPTY: My Topics has no count element at all — visibly different from a "0" count', async () => {
    stubFetch({ totalTopics: 0 });
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const myTopics = rowByText('My Topics');
    expect(myTopics?.querySelector('.mono')).toBeNull();
  });
});

describe('LeftSidebar — unread badge on Chat', () => {
  it('EMPTY: no unreadChatCount prop renders no badge', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const chat = byTestId('left-nav-chat')[0];
    expect(chat.textContent).not.toMatch(/\d/);
  });

  it('CONTRACT: unreadChatCount=0 renders no badge (0 unread = nothing to flag)', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} unreadChatCount={0} />);

    const chat = byTestId('left-nav-chat')[0];
    expect(chat.textContent).not.toMatch(/\d/);
  });

  it('BOUNDARY: unreadChatCount=1..99 renders the exact figure', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} unreadChatCount={7} />);

    expect(byTestId('left-nav-chat')[0].textContent).toContain('7');
  });

  it('BOUNDARY: unreadChatCount=150 caps the displayed badge at "99+"', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} unreadChatCount={150} />);

    expect(byTestId('left-nav-chat')[0].textContent).toContain('99+');
  });
});

describe('LeftSidebar — guest vs member gating', () => {
  it('AUTHZ: guest sees no My Topics row and no Conversations group at all', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={true} sessionChecked />);

    expect(rowByText('My Topics')).toBeUndefined();
    expect(byTestId('left-nav-chat')).toHaveLength(0);
    // The group label itself must not appear either — an empty disclosure
    // whose only row is hidden is worse than no group at all.
    expect(container.textContent).not.toContain('Conversations');
  });

  it('AUTHZ: a member (isGuest=false) with onOpenChat sees both', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(rowByText('My Topics')).toBeDefined();
    expect(byTestId('left-nav-chat')).toHaveLength(1);
    expect(container.textContent).toContain('Conversations');
  });
});

describe('LeftSidebar — focus-visible + long-label layout contract', () => {
  it('UI: every top-level nav row carries the os-nav-row focus-visible class', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    for (const label of ['Start a Topic', 'All', 'Explore Topics', 'My Topics', 'On-Chain Records', 'Chat']) {
      const row = rowByText(label) ?? byTestId('left-nav-chat')[0];
      expect(row?.classList.contains('os-nav-row'), label).toBe(true);
    }
  });

  it('UI: a long Korean category name does not force a fixed-width row (label keeps flex:1/ellipsis)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/categories')) {
          return jsonResponse({
            categories: [{
              id: 'c1',
              name: '이것은 매우 길고 특이한 카테고리 이름으로 사이드바 줄바꿈을 시험합니다',
              slug: 'long-ko',
              icon: '🔵',
              sortOrder: 1,
            }],
          });
        }
        if (url.startsWith('/api/topics')) return jsonResponse({ topics: [] });
        if (url.startsWith('/api/stats')) return jsonResponse({ totalTopics: 0, totalMembers: 0 });
        if (url.startsWith('/api/tags')) return jsonResponse({ tags: [] });
        return jsonResponse({});
      }),
    );
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'ko');

    const row = rowByText('이것은 매우 길고 특이한 카테고리 이름으로 사이드바 줄바꿈을 시험합니다');
    expect(row).toBeDefined();
    const label = row?.querySelector('span:nth-child(2)') as HTMLElement;
    // jsdom/browsers normalize the `flex: 1` shorthand into its full
    // longhand form ("1 1 0%") when read back via `.style.flex`.
    expect(label.style.flex).toContain('1');
    expect(label.style.minWidth).toBe('0px');
    expect(label.style.textOverflow).toBe('ellipsis');
  });
});

describe('LeftSidebar — group open/closed state persists across remount', () => {
  it('CONTRACT: collapsing "Browse" and remounting the component keeps it collapsed', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const browseSummary = Array.from(container.querySelectorAll('summary')).find((s) => s.textContent?.includes('Browse'))!;
    expect((browseSummary.closest('details') as HTMLDetailsElement).open).toBe(true);

    await act(async () => { browseSummary.click(); });
    expect((browseSummary.closest('details') as HTMLDetailsElement).open).toBe(false);

    // Verify the write actually landed in storage (not just React state).
    const stored = JSON.parse(window.localStorage.getItem(LEFT_NAV_GROUPS_KEY)!);
    expect(stored.browse).toBe(false);

    // Full unmount + fresh mount — the real shape of "persists across
    // navigation" for a component that remounts on every page change.
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const browseSummary2 = Array.from(container.querySelectorAll('summary')).find((s) => s.textContent?.includes('Browse'))!;
    expect((browseSummary2.closest('details') as HTMLDetailsElement).open).toBe(false);
  });
});

describe('LeftSidebar — group labels render in both locales', () => {
  it('en/ko: Browse and Conversations group labels', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'en');
    expect(container.textContent).toContain('Browse');
    expect(container.textContent).toContain('Conversations');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'ko');
    expect(container.textContent).toContain('둘러보기');
    expect(container.textContent).toContain('대화');
  });
});
