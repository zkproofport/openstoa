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
 *
 * Second pass (drawer completeness, from the mobile-header review):
 *   contract  — a Docs row exists and takes its aria-current from the real
 *               pathname; below 768px `Header` hides its Docs link and the
 *               tab bar has no Docs tab, so this row is the only way there
 *   authz     — Docs and Preferences render for guests too (a public route
 *               and two non-auth-gated preferences); Conversations still
 *               does not
 *   contract  — a Preferences group renders BOTH the theme toggle and the
 *               locale switcher, is the LAST group, and its open/closed
 *               state persists across a remount like every other group
 *   contract  — the Chat row's phone-width suppression is a CSS rule on the
 *               whole group (label included), NOT a JS breakpoint read: the
 *               row stays mounted, so desktop — which has no tab bar and no
 *               other chat entry — is untouched, and the rule lives in a
 *               `(max-width: 767px)` block with no min-width counterpart
 *   ui        — every new control is a real focusable button with an
 *               explicit focus-visible rule; the preferences row wraps
 *               instead of overflowing the 280px drawer and clears the home
 *               indicator; the Docs label can shrink (longer ko string)
 *   en/ko     — Docs and Preferences labels translate; locale labels never
 *               do (see `localeSwitcher.test.tsx`)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { join } from 'path';

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

  // Regression: "All" is state-driven and used to ignore the pathname
  // entirely, so on `/recorded` and `/topics/explore` — both of which render
  // this sidebar — TWO rows announced themselves as the current page.
  it.each([
    ['/recorded', 'On-Chain Records'],
    ['/topics/explore', 'Explore Topics'],
    ['/docs', 'Docs'],
  ])('CONTRACT: on %s exactly one row is aria-current, and it is %s', async (path, label) => {
    stubFetch();
    pathnameMock.current = path;
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const current = Array.from(container.querySelectorAll('[aria-current="page"]'));
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain(label);
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

// ── Docs row ────────────────────────────────────────────────────────────────
// `Header` hides its three text links below 768px and `BottomTabBar` has no
// Docs tab, so this row is the ONLY route to `/docs` on a phone.

describe('LeftSidebar — Docs row', () => {
  function docsRow(): HTMLAnchorElement | undefined {
    return Array.from(container.querySelectorAll('a.os-nav-row'))
      .find((a) => (a as HTMLAnchorElement).getAttribute('href') === '/docs') as HTMLAnchorElement | undefined;
  }

  it('CONTRACT: the row exists and points at /docs (the only phone-reachable route to it)', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const row = docsRow();
    expect(row).toBeDefined();
    expect(row?.textContent).toContain('Docs');
  });

  it('CONTRACT: it carries aria-current="page" on /docs, and no other row does', async () => {
    stubFetch();
    pathnameMock.current = '/docs';
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(docsRow()?.getAttribute('aria-current')).toBe('page');
    expect(rowByText('Explore Topics')?.getAttribute('aria-current')).toBeNull();
    expect(rowByText('On-Chain Records')?.getAttribute('aria-current')).toBeNull();
    // "All" is state-driven, not route-driven — it must not claim to be the
    // current view while the user is reading the docs.
    expect(rowByText('All')?.getAttribute('aria-current')).toBeNull();
  });

  it('CONTRACT: it carries no aria-current on any other route', async () => {
    stubFetch();
    pathnameMock.current = '/recorded';
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(docsRow()?.getAttribute('aria-current')).toBeNull();
  });

  it('AUTHZ: a guest sees it too — /docs is a public route', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={true} sessionChecked />);

    expect(docsRow()).toBeDefined();
  });

  it('UI: focus-visible class + a label that can shrink (nothing fixed-width for the longer ko string)', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const row = docsRow()!;
    expect(row.classList.contains('os-nav-row')).toBe(true);
    const label = row.querySelector('span:nth-child(2)') as HTMLElement;
    expect(label.style.flex).toContain('1');
    expect(label.style.minWidth).toBe('0px');
    expect(label.style.textOverflow).toBe('ellipsis');
  });

  it('en/ko: the label is translated, not hardcoded English', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'ko');
    expect(docsRow()?.textContent).toContain('문서');
    expect(docsRow()?.textContent).not.toContain('Docs');
  });
});

// ── Preferences group ───────────────────────────────────────────────────────

describe('LeftSidebar — Preferences group', () => {
  function prefsRow(): HTMLElement | undefined {
    return byTestId('left-nav-preferences')[0];
  }

  it('CONTRACT: the group renders BOTH controls — theme toggle and locale switcher', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const row = prefsRow();
    expect(row).toBeDefined();
    // Theme: the toggle is named for its destination ("switch to light"),
    // and starts from the DOM's own data-theme (dark by default).
    expect(row!.querySelector('button[aria-label="Switch to light theme"]')).not.toBeNull();
    // Language: the same `LocaleSwitcher` the header renders — labelled
    // group + one button per locale, each named in its own language.
    const localeGroup = row!.querySelector('[role="group"][aria-label="Language"]');
    expect(localeGroup).not.toBeNull();
    expect(Array.from(localeGroup!.querySelectorAll('button')).map((b) => b.textContent))
      .toEqual(['English', '한국어']);
  });

  it('CONTRACT: it is its OWN labelled group, and the LAST one (settings sit below destinations)', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const summaries = Array.from(container.querySelectorAll('summary')).map((s) => s.textContent ?? '');
    expect(summaries[summaries.length - 1]).toContain('Preferences');
    // And the controls live inside that group, not loose in the nav.
    expect(prefsRow()!.closest('details')?.querySelector('summary')?.textContent).toContain('Preferences');
  });

  it('AUTHZ: a guest gets it too — neither theme nor language is an auth-gated preference', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={true} sessionChecked />);

    expect(prefsRow()).toBeDefined();
    expect(container.textContent).toContain('Preferences');
  });

  it('UI: the controls row wraps rather than overflowing the 280px drawer, and clears the home indicator', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const row = prefsRow()!;
    expect(row.style.flexWrap).toBe('wrap');
    // jsdom's CSS parser drops `env()` (it is a real browser function but not
    // implemented there), so `row.style.paddingBottom` reads back empty —
    // assert the declaration at the source instead of fabricating a DOM
    // assertion jsdom cannot honor.
    const src = readFileSync(join(process.cwd(), 'src/components/LeftSidebar.tsx'), 'utf-8');
    expect(src).toContain("paddingBottom: 'env(safe-area-inset-bottom, 0px)'");
  });

  it('UI: both controls are real, focusable buttons carrying an explicit focus-visible rule', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const buttons = Array.from(prefsRow()!.querySelectorAll('button'));
    expect(buttons).toHaveLength(3); // theme + two locales
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.hasAttribute('disabled')).toBe(false);
    }
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
    expect(css).toMatch(/\.os-header-btn:focus-visible\s*{[^}]*outline:/s); // ThemeToggle
    expect(css).toMatch(/\.os-locale-btn:focus-visible\s*{[^}]*outline:/s); // LocaleSwitcher
  });

  it('en/ko: the group label is translated', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'ko');
    expect(container.textContent).toContain('환경설정');
    expect(container.textContent).not.toContain('Preferences');
  });

  it('CONTRACT: collapsing it persists across a full unmount + remount, like every other group', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const summary = Array.from(container.querySelectorAll('summary')).find((s) => s.textContent?.includes('Preferences'))!;
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(true);
    await act(async () => { summary.click(); });
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false);

    const stored = JSON.parse(window.localStorage.getItem(LEFT_NAV_GROUPS_KEY)!);
    expect(stored.preferences).toBe(false);

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const summary2 = Array.from(container.querySelectorAll('summary')).find((s) => s.textContent?.includes('Preferences'))!;
    expect((summary2.closest('details') as HTMLDetailsElement).open).toBe(false);
  });
});

// ── Chat row: hidden only where the bottom tab bar already provides it ──────

describe('LeftSidebar — Chat group is suppressed at phone width only', () => {
  it('CONTRACT: the WHOLE Conversations group (label included) carries the mobile-dupe class, not just the row', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    const group = byTestId('left-nav-chat')[0].closest('details') as HTMLDetailsElement;
    expect(group.classList.contains('os-nav-mobile-dupe')).toBe(true);
    // Hiding the row alone would leave an empty labelled disclosure, which
    // is the same anti-pattern the guest branch already avoids.
    expect(group.querySelector('summary')?.textContent).toContain('Conversations');
  });

  it('CONTRACT: the row is still MOUNTED (CSS hiding, not a JS breakpoint read) — desktop keeps its only chat entry', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    // No matchMedia dependency: the component renders identically at every
    // width, and `CommunityLayout` + this rule decide what is on screen.
    expect(byTestId('left-nav-chat')).toHaveLength(1);
  });

  it('CONTRACT: the row still opens the rail when it IS visible (hiding did not break the action)', async () => {
    stubFetch();
    const onOpenChat = vi.fn();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={onOpenChat} />);

    await act(async () => { (byTestId('left-nav-chat')[0] as HTMLButtonElement).click(); });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('CONTRACT: globals.css hides that class below 767px only — the same cut as MOBILE_QUERY / the drawer swap', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
    const block = css.match(/@media \(max-width: 767px\) {[^@]*?\.os-nav-mobile-dupe\s*{[^}]*}/s);
    expect(block, '.os-nav-mobile-dupe must be hidden inside a (max-width: 767px) block').not.toBeNull();
    expect(block![0]).toMatch(/display:\s*none/);
    // No min-width counterpart: the rule must not also hide it on desktop.
    expect(css).not.toMatch(/@media \(min-width: 768px\) {[^@]*?\.os-nav-mobile-dupe/s);
  });

  it('CONTRACT: exactly one element claims that class (one rule, one purpose)', async () => {
    const sidebar = readFileSync(join(process.cwd(), 'src/components/LeftSidebar.tsx'), 'utf-8');
    expect(sidebar.match(/className="os-nav-mobile-dupe"/g)).toHaveLength(1);

    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);
    const hidden = container.querySelectorAll('.os-nav-mobile-dupe');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].tagName).toBe('DETAILS');
  });
});
