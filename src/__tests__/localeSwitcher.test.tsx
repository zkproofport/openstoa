// @vitest-environment jsdom
/**
 * `LocaleSwitcher.tsx` (FIX6) — the UI that was missing entirely: the
 * `NEXT_LOCALE` cookie / `setLocale()` mechanism already existed, but
 * nothing ever called it, so the Korean catalogue was unreachable.
 *
 * It is now a `<select>`, not a pair of toggle buttons: the buttons spent the
 * width of BOTH language names permanently, in a header row that also carries
 * a hamburger, a logo, a theme toggle and a session chip — for a control
 * where only one of the two is ever actionable.
 *
 * Edge-case matrix rows covered here:
 *   boundary  — exactly two options (en/ko), generated from SUPPORTED_LOCALES
 *   contract  — the ACTIVE locale is the select's value; changing the select
 *               switches locale (and the labels stay untranslated in both)
 *   hostile   — a `change` carrying a value outside SUPPORTED_LOCALES is
 *               rejected rather than laundered into `setLocale`
 *   a11y      — an accessible name exists with no visible <label> anywhere it
 *               mounts, plus a real focus-visible ring and a >= 44px target
 *   iOS       — >= 16px font, or Safari zooms the page on focus in a sticky
 *               header
 *   narrow    — no width/max-width anywhere: the Korean label is the longer
 *               of the two and both must fit down to a 320px viewport
 *   contract  — it is STILL a real <select> after the restyle: `appearance:
 *               none` repaints it, it does not replace it, so mobile keeps the
 *               native picker and the keyboard contract stays the UA's
 *   theme     — the custom chevron is drawn in `currentColor`, so ONE
 *               declaration covers light, dark and the :hover color change;
 *               there is no second copy that can drift out of sync
 *   layout    — the trailing padding actually clears the chevron (a chevron
 *               painted over the label is worse than the native arrow was)
 *   UTF-8     — `한국어` renders under BOTH locales, never translated
 *   contract  — persistence and the `<html lang>` flip are I18nProvider's own
 *               contract (see `i18nProvider.test.tsx`) — not re-asserted here,
 *               only that this component is wired to the same
 *               `useTranslation()` state a Header/drawer/`/my` instance shares
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/**
 * Always mounts a FRESH root. `I18nProvider` seeds its state from
 * `initialLocale` once — it is initial state, not a controlled prop — so
 * re-rendering the same root with a different locale would silently keep the
 * old one and make every assertion about the new locale vacuous.
 */
function render(initialLocale: Locale = 'en', props: React.ComponentProps<typeof LocaleSwitcher> = {}) {
  act(() => {
    root.unmount();
  });
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider initialLocale={initialLocale}>
        <LocaleSwitcher {...props} />
      </I18nProvider>,
    );
  });
}

function select(): HTMLSelectElement {
  return container.querySelector('select') as HTMLSelectElement;
}

function options(): HTMLOptionElement[] {
  return Array.from(container.querySelectorAll('option'));
}

/** How a browser reports a user's pick: set `.value`, then fire `change`. */
function pick(value: string) {
  act(() => {
    const el = select();
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const GLOBALS_CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
/** The `.os-locale-select { … }` block, without the `:hover`/`:focus` ones. */
const BASE_RULE = GLOBALS_CSS.match(/\.os-locale-select\s*{([^}]*)}/)?.[1] ?? '';

describe('LocaleSwitcher', () => {
  it('is a single <select>, not one control per locale', () => {
    render();
    expect(container.querySelectorAll('select')).toHaveLength(1);
    // The whole point of the change: no per-locale buttons spending width.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('BOUNDARY: renders exactly two options, each named in its OWN language', () => {
    render();
    const opts = options();
    expect(opts).toHaveLength(2);
    expect(opts.map((o) => o.value)).toEqual(['en', 'ko']);
    // Not "EN"/"KO": those are English abbreviations of language names, so
    // the control that switches AWAY from English was only readable to
    // someone who already reads English.
    expect(opts.map((o) => o.textContent)).toEqual(['English', '한국어']);
  });

  it('UTF-8/CONTRACT: the labels are NOT translated — the ko surface still says "English", the en surface still says "한국어"', () => {
    for (const initialLocale of ['en', 'ko'] as const) {
      render(initialLocale);
      expect(options().map((o) => o.textContent), initialLocale).toEqual(['English', '한국어']);
    }
  });

  it('CONTRACT: the select reflects the active locale', () => {
    render('en');
    expect(select().value).toBe('en');

    render('ko');
    expect(select().value).toBe('ko');
  });

  it('CONTRACT: choosing the other locale switches locale (the cookie the provider owns is written too)', () => {
    render('en');
    pick('ko');

    expect(select().value).toBe('ko');
    expect(document.cookie).toContain('NEXT_LOCALE=ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('CONTRACT: switching back to the original locale works (not a one-way trip)', () => {
    render('en');
    pick('ko');
    pick('en');
    expect(select().value).toBe('en');
    expect(document.cookie).toContain('NEXT_LOCALE=en');
  });

  it('HOSTILE: a change carrying a value outside SUPPORTED_LOCALES is rejected, not passed to setLocale', () => {
    render('en');
    // A hand-added <option>, a stray dispatch, a future bug — `e.target.value`
    // is typed `string`, so the component checks rather than casting.
    pick('de');
    expect(select().value).toBe('en');
    expect(document.cookie).not.toContain('NEXT_LOCALE=de');
    expect(document.documentElement.lang).not.toBe('de');
  });

  it('A11Y: has an accessible name — it mounts with no visible <label> in the header or the drawer', () => {
    render();
    expect(select().getAttribute('aria-label')).toBe('Language');
  });

  it('A11Y: the accessible name IS translated, unlike the option labels', () => {
    render('ko');
    expect(select().getAttribute('aria-label')).toBe('언어');
  });

  it('A11Y: carries an explicit focus-visible ring and a >= 44px target', () => {
    render();
    expect(select().className).toContain('os-locale-select');
    expect(GLOBALS_CSS).toMatch(/\.os-locale-select:focus-visible\s*{[^}]*outline:\s*2px solid/s);
    expect(BASE_RULE).toContain('min-height: var(--touch-target-min)');
  });

  it('iOS: font-size is the 16px body token — below that Safari zooms the page on focus in a sticky header', () => {
    expect(BASE_RULE).toContain('font-size: var(--text-body)');
  });

  it('NARROW: no fixed width — the Korean label is the longer one and both must fit at 320px', () => {
    expect(BASE_RULE).not.toMatch(/(^|[^-])width:/);
  });

  it('TOKENS: colors/spacing come from tokens only, no raw values', () => {
    for (const decl of ['border: 1px solid var(--color-border-default)', 'background: var(--color-bg-secondary)', 'color: var(--color-text-secondary)']) {
      expect(BASE_RULE).toContain(decl);
    }
  });

  it('STYLED: the native control chrome is suppressed — that grey UA ground/arrow ignored every token above it', () => {
    expect(BASE_RULE).toContain('appearance: none');
    // Safari (desktop and iOS) still needs the prefixed form.
    expect(BASE_RULE).toContain('-webkit-appearance: none');
  });

  it('CONTRACT: it is still a real <select>, not a div listbox — `appearance` repaints, it does not replace', () => {
    render();
    const el = select();
    expect(el.tagName).toBe('SELECT');
    // The native picker and the whole keyboard contract (Up/Down, type-ahead,
    // Enter/Escape) ride on this being a <select>; nothing here re-implements
    // them, and a custom listbox would have had to.
    expect(el.getAttribute('role')).toBeNull();
    expect(container.querySelectorAll('[role="listbox"], [role="option"]')).toHaveLength(0);
    expect(options()).toHaveLength(2);
  });

  it('CHEVRON: a custom one is drawn, positioned on the trailing edge, and does not repeat', () => {
    expect(BASE_RULE).toMatch(/background-image:\s*\n?\s*linear-gradient\(45deg,/);
    expect(BASE_RULE).toContain('linear-gradient(-45deg,');
    expect(BASE_RULE).toContain('background-repeat: no-repeat');
    expect(BASE_RULE).toContain('background-position: right 14px center, right 8px center');
  });

  it('THEME: the chevron is currentColor, so light, dark and :hover all resolve from one declaration', () => {
    // A data-URI SVG cannot read `currentColor`, so it would have needed a
    // hardcoded light copy and dark copy — two values that can drift. Gradients
    // can, which is the whole reason the chevron is drawn this way.
    const chevron = BASE_RULE.match(/background-image:([\s\S]*?);/)?.[1] ?? '';
    expect(chevron).toContain('currentColor');
    expect(chevron).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chevron).not.toMatch(/\brgba?\(/);
    expect(chevron).not.toContain('url(');
  });

  it('LAYOUT: the trailing padding clears the chevron, so the label never runs under it', () => {
    // Chevron occupies 8px..20px in from the trailing edge (two 6px boxes at
    // right-8 and right-14), so the trailing padding has to exceed 20px.
    // --space-6 is 32px; --space-3 (12px) is the leading side.
    expect(BASE_RULE).toContain('padding: 0 var(--space-6) 0 var(--space-3)');
  });

  it('CONTRACT: it still changes locale after the restyle — the styling touched paint, not behaviour', () => {
    render('en');
    pick('ko');
    expect(select().value).toBe('ko');
    expect(document.cookie).toContain('NEXT_LOCALE=ko');
  });

  it('composes an extra className (the header hides it at phone widths through one)', () => {
    render('en', { className: 'header-dupe-mobile' });
    expect(select().className).toBe('os-locale-select header-dupe-mobile');
  });

  it('renders without an extra className, with no trailing space in the attribute', () => {
    render();
    expect(select().className).toBe('os-locale-select');
  });
});
