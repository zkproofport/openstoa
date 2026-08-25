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

import { TestProviders } from './harness/providers';
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
    root.render(<TestProviders initialLocale={locale}>{ui}</TestProviders>);
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

describe('LeftSidebar — there is no chat entry on the web', () => {
  /*
   * This block used to assert the opposite: a Chat row, its unread badge, and
   * the counting rules for 0 / 1..99 / 99+. All of it is gone, and asserting
   * its ABSENCE is not a smaller test — it is the one that matters now.
   *
   * WHY THE ROW WENT. A browser cannot read a room: the keys are on the phone
   * and never leave it. What it COULD do was join the group, advance an epoch
   * and post ciphertext nobody would ever open — damage rather than nothing.
   * On top of that, signing out cleared the session and left the MLS state in
   * IndexedDB, the leaf identity in `localStorage`, and the decrypted-picture
   * cache on disk, so the next person at a shared machine could read the
   * previous person's conversation.
   *
   * The badge rules did not disappear with it — they moved to
   * `@openstoa/mls/chatUnreadBadge`, which the mini-app uses and which has its
   * own boundary cases for 0 / 1..99 / 99+.
   */
  it('CONTRACT: a member with an unread count still gets no chat row', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked unreadChatCount={7} />);

    expect(byTestId('left-nav-chat')).toHaveLength(0);
  });

  it('BOUNDARY: a large unread count renders nothing rather than a stray "99+"', async () => {
    // A count arriving from a stale prop must not resurrect the entry point.
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked unreadChatCount={150} />);

    expect(container.textContent).not.toContain('99+');
    expect(byTestId('left-nav-chat')).toHaveLength(0);
  });

  it('INTEGRITY: passing onOpenChat does not bring the row back', async () => {
    // The prop may still exist on the type for a while. A leftover caller must
    // not be able to reinstate a surface that was removed on purpose.
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(byTestId('left-nav-chat')).toHaveLength(0);
    expect(container.textContent).not.toContain('Conversations');
  });
});

describe('LeftSidebar — guest vs member gating', () => {
  it('AUTHZ: guest sees no My Topics row and no Conversations group at all', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={true} sessionChecked />);

    expect(rowByText('My Topics')).toBeUndefined();
    expect(byTestId('left-nav-chat')).toHaveLength(0);
    expect(container.textContent).not.toContain('Conversations');
  });

  it('AUTHZ: a member sees My Topics — and, like a guest, no chat', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(rowByText('My Topics')).toBeDefined();
    // The one place member and guest now agree: chat is on the phone.
    expect(byTestId('left-nav-chat')).toHaveLength(0);
    expect(container.textContent).not.toContain('Conversations');
  });
});

describe('LeftSidebar — focus-visible + long-label layout contract', () => {
  it('UI: every top-level nav row carries the os-nav-row focus-visible class', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    // 'Chat' is deliberately absent from this list — the web has no chat row.
    for (const label of ['Start a Topic', 'All', 'Explore Topics', 'My Topics', 'On-Chain Records']) {
      const row = rowByText(label);
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
  it('en/ko: the Browse group label — and no Conversations group in either locale', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'en');
    expect(container.textContent).toContain('Browse');
    // The Conversations group went with web chat. Checked in BOTH locales
    // because a removal that only lands in English is how a stray Korean
    // string survives a cleanup.
    expect(container.textContent).not.toContain('Conversations');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />, 'ko');
    expect(container.textContent).toContain('둘러보기');
    expect(container.textContent).not.toContain('대화');
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
    // Language: the same `LocaleSwitcher` the header renders — one <select>
    // (it used to be one button per locale) with an option per locale, each
    // named in its own language and never translated.
    const localeSelect = row!.querySelector('select[aria-label="Language"]');
    expect(localeSelect).not.toBeNull();
    expect(Array.from(localeSelect!.querySelectorAll('option')).map((o) => o.textContent))
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

  it('UI: both controls are real, focusable, enabled, and carry an explicit focus-visible rule', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    // Two controls, not three: `LocaleSwitcher` is one <select> now, where it
    // used to be one button per locale. The old pair spent the width of BOTH
    // language names permanently for a control where only one of the two was
    // ever actionable.
    const theme = Array.from(prefsRow()!.querySelectorAll('button'));
    const locale = Array.from(prefsRow()!.querySelectorAll('select'));
    expect(theme).toHaveLength(1);
    expect(locale).toHaveLength(1);
    for (const el of [...theme, ...locale]) {
      expect(el.hasAttribute('disabled')).toBe(false);
    }
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
    expect(css).toMatch(/\.os-header-btn:focus-visible\s*{[^}]*outline:/s); // ThemeToggle
    expect(css).toMatch(/\.os-locale-select:focus-visible\s*{[^}]*outline:/s); // LocaleSwitcher
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

describe('LeftSidebar — the Chat group is gone, not merely hidden', () => {
  /*
   * This block used to check that the Conversations group carried a
   * `mobile-dupe` class: the row existed on desktop and was hidden by CSS at
   * phone width, where the bottom tab bar already offered chat.
   *
   * There is no row to hide now. The distinction still matters enough to keep
   * a case for: hiding with CSS leaves a mounted element that a keyboard or a
   * screen reader can still reach, and "chat is not available here" has to be
   * true for those users too — not just for the ones who can see the layout.
   */
  it('CONTRACT: no chat row is mounted at any width, hidden or otherwise', async () => {
    stubFetch();
    await renderSidebar(<LeftSidebar isGuest={false} sessionChecked onOpenChat={() => {}} />);

    expect(byTestId('left-nav-chat')).toHaveLength(0);
    expect(container.querySelectorAll('.mobile-dupe')).toHaveLength(0);
  });
});
