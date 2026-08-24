// @vitest-environment jsdom
/**
 * `Header.tsx` — FIX7 (collapse duplicate chat entry points) + FIX8 (move
 * Recovery out of the top-level nav) + the phone-width strip-down.
 *
 * Edge-case matrix rows covered here:
 *   contract — the chat rail toggle is the ONLY chat/DM entry point in the
 *              header; the old "Messages" full-page link to `/dm` is gone
 *   contract — no `/recovery` link in the top-level nav (moved to `/my`'s
 *              Settings tab — see `myPageRecovery.test.tsx`)
 *   authz    — a guest sees neither the chat toggle nor any signed-in-only
 *              link, even when `onChatToggle` is passed (defence in depth:
 *              `CommunityLayout` already withholds `onChatToggle` from a
 *              guest, but the button itself is also gated on `user`)
 *   contract — pages that render `Header` standalone (no `onChatToggle`
 *              passed) never render a chat toggle with nothing to toggle
 *   mobile   — below 768px and ONLY under `.has-app-shell`, everything
 *              the drawer + tab bar already provide is hidden: the wordmark
 *              TEXT (the logo mark stays), the theme toggle, the language
 *              select, and the session chip / guest Sign in CTA. What is
 *              left is a hamburger and the logo mark.
 *   authz    — the hidden set is the SAME for a guest and a member: the
 *              guest's Sign in CTA goes too, since a guest signs in at the
 *              point of need, not from a permanent header button
 *   contract — the standalone pages (`/docs`, `/recovery`, `/profile`, which
 *              render this Header WITHOUT CommunityLayout) get no
 *              `.has-app-shell`, so they keep every control — they have
 *              neither drawer nor tab bar to inherit them from
 *   race     — the pre-session placeholder that reserves the chip's footprint
 *              is hidden on the same terms as the chip, or it reserves 88px
 *              of nothing in a row meant to be empty
 *
 * Header polish pass — three more rows:
 *   contract — Explore / Recorded / Docs are absent from the DOM at EVERY
 *              width when the app shell is present (`LeftSidebar` carries all
 *              three), and PRESENT when it is not. The second half is the
 *              regression that would strand `/docs`, `/recovery`, `/profile`
 *              with no navigation whatsoever, so it is asserted first.
 *   naming   — the old phone-only class name is renamed to `has-app-shell`;
 *              the old string must not survive anywhere under `src/`, comments
 *              included (which is why this file never spells it out either —
 *              see OLD_NAME below)
 *   layout   — inside the app shell at phone widths the mark is centred
 *              against the HEADER (absolute + left:50%), not against the flex
 *              space left over beside a 44px hamburger; the hamburger itself
 *              is a ghost button that still owns a hover, a focus ring and a
 *              44px target
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import Header from '@/components/Header';
import { TestProviders, flushQueries } from './harness/providers';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

/*
 * A macrotask drain, not a microtask one.
 *
 * The header now reads its session through TanStack Query, which delivers
 * results via `notifyManager` on a real `setTimeout(0)` — so draining
 * microtasks alone left every query result undelivered and the signed-in chip
 * never rendered. Same helper, same reason, as the mini-app harness's `settle`.
 */
const flush = flushQueries;

async function render(props: React.ComponentProps<typeof Header> = {}) {
  await act(async () => {
    root.render(
      <TestProviders initialLocale="en">
        <Header {...props} />
      </TestProviders>,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('signed in, inside CommunityLayout (onChatToggle passed)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
  });

  it('CONTRACT: the chat rail toggle is present and is the ONLY chat/DM entry point', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('button[aria-label="Open chat"]')).not.toBeNull();
    // The old full-page "Messages" link to /dm is gone.
    expect(container.querySelector('a[href="/dm"]')).toBeNull();
    expect(container.textContent).not.toContain('Messages');
  });

  it('FIX8: no /recovery link in the top-level nav', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('a[href="/recovery"]')).toBeNull();
  });

  it('clicking the chat toggle invokes onChatToggle', async () => {
    const onChatToggle = vi.fn();
    await render({ onChatToggle, chatOpen: false });

    await act(async () => {
      (container.querySelector('button[aria-label="Open chat"]') as HTMLButtonElement).click();
    });
    expect(onChatToggle).toHaveBeenCalledTimes(1);
  });

  it('reflects the open state via aria-pressed / aria-label', async () => {
    await render({ onChatToggle: vi.fn(), chatOpen: true });

    const btn = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Close chat');
  });
});

describe('CONTRACT: standalone Header (no onChatToggle — recovery/docs/profile pages)', () => {
  it('never renders a chat toggle with nothing to toggle, even when signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(container.querySelector('button[aria-label="Open chat"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Close chat"]')).toBeNull();
  });
});

describe('AUTHZ: guest', () => {
  it('sees no chat toggle even if onChatToggle is passed, and no signed-in-only links', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('button[aria-label="Open chat"]')).toBeNull();
    expect(container.querySelector('a[href="/dm"]')).toBeNull();
    expect(container.querySelector('a[href="/recovery"]')).toBeNull();
    expect(container.querySelector('a[href="/"]')?.textContent).toBe('Sign in');
  });

  it('FIX6: still sees the language switcher — not an auth-gated preference', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onChatToggle: vi.fn(), chatOpen: false });

    expect(container.querySelector('select[aria-label="Language"]')).not.toBeNull();
  });
});

/**
 * Phone-width strip-down. jsdom does not evaluate media queries against a
 * viewport, so these assert the two halves that make the behaviour real: the
 * CLASS is on the right elements, and the RULE that hides that class exists in
 * the header's own <style> under the right scope. Verified visually at 390px
 * on staging before landing.
 */
describe('MOBILE: below 768px the header keeps only the hamburger + logo mark', () => {
  /** The header's inline <style> block — the rules under test live here. */
  function css(): string {
    return container.querySelector('style')?.textContent ?? '';
  }

  function hidden(el: Element | null | undefined): boolean {
    return el?.classList.contains('header-dupe-mobile') ?? false;
  }

  it('CONTRACT: the hiding rules exist, and both are scoped to .has-app-shell', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(css()).toMatch(/@media \(max-width: 767px\)/);
    expect(css()).toMatch(/\.has-app-shell \.header-dupe-mobile\s*{\s*display: none/);
    expect(css()).toMatch(/\.has-app-shell \.header-wordmark\s*{\s*display: none/);
  });

  it('CONTRACT: the header opts into the mobile chrome only when a drawer exists (onMenuToggle passed)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(container.querySelector('header')?.classList.contains('has-app-shell')).toBe(true);
  });

  it('CONTRACT: standalone pages (/docs, /recovery, /profile) get NO .has-app-shell, so they keep every control', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(container.querySelector('header')?.classList.contains('has-app-shell')).toBe(false);
    // The controls themselves are still rendered — they have to be, since
    // nothing else on those pages offers theme, language or the wordmark.
    expect(container.querySelector('select[aria-label="Language"]')).not.toBeNull();
    expect(container.querySelector('.header-wordmark')).not.toBeNull();
  });

  it('the wordmark TEXT is hidden but the logo mark <img> stays, and the link keeps its accessible name', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    const wordmark = container.querySelector('.header-wordmark');
    expect(wordmark?.textContent).toBe('OpenStoa');
    const logoLink = container.querySelector('a[href="/topics"]') as HTMLAnchorElement;
    expect(logoLink.querySelector('img')).not.toBeNull();
    // Hiding the text costs no information: the link is named independently.
    expect(logoLink.getAttribute('aria-label')).toBe('OpenStoa home');
  });

  it('the hamburger is NOT hidden — it is one of the two things left', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    const burger = container.querySelector('.header-hamburger');
    expect(burger).not.toBeNull();
    expect(hidden(burger)).toBe(false);
    expect(css()).toMatch(/\.header-hamburger\s*{\s*display: flex !important/);
  });

  it('MEMBER: theme toggle, language select, chat toggle and nickname chip are all hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn(), chatOpen: false });

    expect(hidden(container.querySelector('button[aria-label^="Switch to"], button[title^="Switch to"]'))).toBe(true);
    expect(hidden(container.querySelector('select[aria-label="Language"]'))).toBe(true);
    expect(hidden(container.querySelector('button[aria-label="Open chat"]'))).toBe(true);
    expect(hidden(container.querySelector('a[href="/my"]'))).toBe(true);
  });

  it('AUTHZ: a GUEST loses the same set — the Sign in CTA goes too (signing in happens at the point of need)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn(), chatOpen: false });

    const signIn = container.querySelector('a[href="/"]');
    expect(signIn?.textContent).toBe('Sign in');
    expect(hidden(signIn)).toBe(true);
    expect(hidden(container.querySelector('select[aria-label="Language"]'))).toBe(true);
  });

  it('RACE: the pre-session placeholder is hidden too, or it reserves 88px of nothing', async () => {
    // A fetch that never settles — the header stays in its unresolved state,
    // which is exactly the window this placeholder exists for.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    const placeholder = container.querySelector('nav > span[style*="88px"]');
    expect(placeholder).not.toBeNull();
    expect(hidden(placeholder)).toBe(true);
  });

  it('the search bar stays hidden, and the nav-link hide rule survives for the STANDALONE header', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    // Inside the app shell the three links are no longer rendered at all, so
    // this rule is now dead weight HERE — but it is the only thing keeping the
    // standalone row (wordmark + three links + theme + language + chip) from
    // overflowing at 320px, and that header shares this same <style> block.
    expect(css()).toMatch(/\.header-nav-link\s*{\s*display: none !important/);
    expect(css()).toMatch(/\.header-search-wrap\s*{\s*display: none !important/);
  });

  it('LAYOUT: the mark is centred against the HEADER, not against the leftover flex space', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    // The rule has to be absolute + left:50%. A flex-based centring would
    // measure against the space beside a 44px hamburger and land right of
    // centre — which is the bug being fixed, not a different way to fix it.
    expect(css()).toMatch(
      /\.has-app-shell \.header-brand\s*{\s*position: absolute;\s*left: 50%;\s*top: 50%;\s*transform: translate\(-50%, -50%\);/,
    );
    // And the element the rule targets actually exists, with the mark in it.
    const brand = container.querySelector('a.header-brand');
    expect(brand).not.toBeNull();
    expect(brand?.querySelector('img')).not.toBeNull();
  });

  it('LAYOUT: the centring is scoped — a standalone header keeps the mark in flow beside its wordmark and search bar', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(container.querySelector('header')?.classList.contains('has-app-shell')).toBe(false);
    // Same <style> block, but the selector cannot match without the class, so
    // the absolutely-positioned mark can never land on top of the search bar.
    // Asserted as "the ONLY rule targeting .header-brand is the scoped one" —
    // an unscoped duplicate added later would break this, where a plain
    // `toMatch` on the scoped rule would keep passing beside it.
    const brandSelectors = Array.from(css().matchAll(/([^{}\n]*\.header-brand[^{}\n]*?)\s*{/g)).map(
      (m) => m[1].trim(),
    );
    expect(brandSelectors).toEqual(['.has-app-shell .header-brand']);
  });
});

/**
 * The hamburger's weight. It sits next to a bare 24px logo mark and nothing
 * else, so a filled + bordered box there is the loud half of a two-element
 * row — the actual "겹쳐서 이상하다". Ghost styling normally costs the hover
 * ground and the focus ring; these assert it did not here.
 */
describe('GHOST HAMBURGER', () => {
  const GLOBALS_CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
  const GHOST_RULE = GLOBALS_CSS.match(/\.os-header-btn-ghost\s*{([^}]*)}/)?.[1] ?? '';

  it('uses the ghost class, NOT the filled/bordered .os-header-btn', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    const burger = container.querySelector('.header-hamburger') as HTMLButtonElement;
    expect(burger.classList.contains('os-header-btn-ghost')).toBe(true);
    expect(burger.classList.contains('os-header-btn')).toBe(false);
  });

  it('is transparent and borderless — the two things "ghost" means', () => {
    expect(GHOST_RULE).toContain('background: transparent');
    expect(GHOST_RULE).toContain('border: none');
  });

  it('A11Y: keeps a >= 44px target in BOTH axes despite zero padding and no border', () => {
    expect(GHOST_RULE).toContain('min-height: var(--touch-target-min)');
    expect(GHOST_RULE).toContain('min-width: var(--touch-target-min)');
  });

  it('A11Y: keeps a hover ground and a focus-visible ring — with no border, the ring is the ONLY focus signal', () => {
    expect(GLOBALS_CSS).toMatch(
      /\.os-header-btn-ghost:hover\s*{[^}]*background: var\(--color-bg-secondary\)/s,
    );
    expect(GLOBALS_CSS).toMatch(
      /\.os-header-btn-ghost:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-brand-primary\)/s,
    );
  });

  it('THEME: hover and ring come from tokens, so light and dark both resolve (no literal colors)', () => {
    const ghostBlocks = GLOBALS_CSS.match(/\.os-header-btn-ghost[^{]*{[^}]*}/gs)?.join('\n') ?? '';
    expect(ghostBlocks).not.toBe('');
    expect(ghostBlocks).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(ghostBlocks).not.toMatch(/\brgba?\(/);
  });
});

/**
 * Explore / Recorded / Docs. `LeftSidebar` renders all three, and it is on
 * screen at every width the app shell exists at (desktop rail, phone drawer),
 * so inside the shell the header copies were duplicates — on desktop too, not
 * just on a phone. Outside the shell they are the ONLY navigation there is.
 */
describe('NAV LINKS: removed inside the app shell, kept outside it', () => {
  const NAV_HREFS = ['/topics/explore', '/recorded', '/docs'];

  function navLinks(): string[] {
    return NAV_HREFS.filter((href) => container.querySelector(`a[href="${href}"]`) !== null);
  }

  it('are ABSENT from the DOM when the app shell is present — at every width, not hidden by a media query', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(navLinks()).toEqual([]);
  });

  it('REGRESSION: are PRESENT on a standalone header (/docs, /recovery, /profile) — otherwise those pages have NO navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(navLinks()).toEqual(NAV_HREFS);
    // They are real nav links, not incidental matches elsewhere in the row.
    for (const href of NAV_HREFS) {
      expect(container.querySelector(`a[href="${href}"]`)?.className).toContain('header-nav-link');
    }
  });

  it('AUTHZ: the gate is the app shell, not the session — a GUEST on a standalone page still gets all three', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render();

    expect(navLinks()).toEqual(NAV_HREFS);
  });

  it('AUTHZ: and a guest inside the app shell gets none of them either', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(null))));
    await render({ onMenuToggle: vi.fn() });

    expect(navLinks()).toEqual([]);
  });

  it('UTF-8: the ko locale renders the same three destinations, translated (Korean labels are the longer ones)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await act(async () => {
      root.render(
        <TestProviders initialLocale="ko">
          <Header />
        </TestProviders>,
      );
    });
    await flush();

    expect(navLinks()).toEqual(NAV_HREFS);
    // `.os-label`'s uppercase + tracking is gated to `:lang(en)` (see NavLink),
    // so the Korean labels are not put through Latin letter-spacing.
    const explore = container.querySelector('a[href="/topics/explore"]') as HTMLAnchorElement;
    expect(explore.className).toContain('os-label');
    expect(explore.textContent).not.toBe('Explore');
  });
});

/**
 * The old class name -> `has-app-shell`. The old one described a phone-only
 * concern; the class now also gates a desktop rule. A half-applied rename is
 * silent — a stale selector simply never matches — so this scans the tree.
 */
describe('NAMING: the has-app-shell rename is complete', () => {
  /**
   * Assembled rather than written out, because this file is itself inside the
   * tree being scanned — a literal here would make the test fail on its own
   * source and there would be no honest way to fix that except exempting the
   * one file most likely to hold a stale copy.
   */
  const OLD_NAME = ['has', 'mobile', 'chrome'].join('-');

  /** Every source file under `src/`, so a stale reference cannot hide in one. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('no file under src/ mentions the old class name — selectors, classNames or prose', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((f) =>
      readFileSync(f, 'utf-8').includes(OLD_NAME),
    );
    expect(offenders).toEqual([]);
  });

  it('the new name is what the header actually stamps, and both hide rules are scoped to it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(container.querySelector('header')?.classList.contains('has-app-shell')).toBe(true);
    const style = container.querySelector('style')?.textContent ?? '';
    expect(style).toMatch(/\.has-app-shell \.header-dupe-mobile\s*{\s*display: none/);
    expect(style).toMatch(/\.has-app-shell \.header-wordmark\s*{\s*display: none/);
  });
});
