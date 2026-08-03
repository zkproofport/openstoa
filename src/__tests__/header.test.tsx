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
 *   mobile   — below 768px and ONLY under `.has-mobile-chrome`, everything
 *              the drawer + tab bar already provide is hidden: the wordmark
 *              TEXT (the logo mark stays), the theme toggle, the language
 *              select, and the session chip / guest Sign in CTA. What is
 *              left is a hamburger and the logo mark.
 *   authz    — the hidden set is the SAME for a guest and a member: the
 *              guest's Sign in CTA goes too, since a guest signs in at the
 *              point of need, not from a permanent header button
 *   contract — the standalone pages (`/docs`, `/recovery`, `/profile`, which
 *              render this Header WITHOUT CommunityLayout) get no
 *              `.has-mobile-chrome`, so they keep every control — they have
 *              neither drawer nor tab bar to inherit them from
 *   race     — the pre-session placeholder that reserves the chip's footprint
 *              is hidden on the same terms as the chip, or it reserves 88px
 *              of nothing in a row meant to be empty
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import Header from '@/components/Header';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(props: React.ComponentProps<typeof Header> = {}) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <Header {...props} />
      </I18nProvider>,
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

  it('CONTRACT: the hiding rules exist, and both are scoped to .has-mobile-chrome', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(css()).toMatch(/@media \(max-width: 767px\)/);
    expect(css()).toMatch(/\.has-mobile-chrome \.header-dupe-mobile\s*{\s*display: none/);
    expect(css()).toMatch(/\.has-mobile-chrome \.header-wordmark\s*{\s*display: none/);
  });

  it('CONTRACT: the header opts into the mobile chrome only when a drawer exists (onMenuToggle passed)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(container.querySelector('header')?.classList.contains('has-mobile-chrome')).toBe(true);
  });

  it('CONTRACT: standalone pages (/docs, /recovery, /profile) get NO .has-mobile-chrome, so they keep every control', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render();

    expect(container.querySelector('header')?.classList.contains('has-mobile-chrome')).toBe(false);
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

  it('the three nav text links and the search bar were already hidden — this change does not resurrect them', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ userId: 'me', nickname: 'me' }))));
    await render({ onMenuToggle: vi.fn(), onChatToggle: vi.fn() });

    expect(css()).toMatch(/\.header-nav-link\s*{\s*display: none !important/);
    expect(css()).toMatch(/\.header-search-wrap\s*{\s*display: none !important/);
  });
});
