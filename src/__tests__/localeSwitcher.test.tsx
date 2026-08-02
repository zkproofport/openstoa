// @vitest-environment jsdom
/**
 * `LocaleSwitcher.tsx` (FIX6) — the UI that was missing entirely: the
 * `NEXT_LOCALE` cookie / `setLocale()` mechanism already existed, but
 * nothing ever called it, so the Korean catalogue was unreachable.
 *
 * Edge-case matrix rows covered here:
 *   boundary — exactly two locale buttons (en/ko), matching SUPPORTED_LOCALES
 *   contract — the ACTIVE locale's button is aria-pressed=true, the other false
 *   contract — clicking the inactive button calls setLocale and flips which
 *              button is pressed
 *   contract — persistence and `<html lang>` flip are I18nProvider's own
 *              contract (see `i18nProvider.test.tsx`) — not re-asserted here,
 *              only that this component is wired to the same `useTranslation()`
 *              state a Header/`/my`-mounted instance would share
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import { I18nProvider } from '@/lib/i18n/I18nProvider';

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

function render() {
  act(() => {
    root.render(
      <I18nProvider initialLocale="en">
        <LocaleSwitcher />
      </I18nProvider>,
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

describe('LocaleSwitcher', () => {
  it('BOUNDARY: renders exactly two locale buttons, each named in its OWN language', () => {
    render();
    const btns = buttons();
    expect(btns).toHaveLength(2);
    // Not "EN"/"KO": those are English abbreviations of language names, so
    // the control that switches AWAY from English was only readable to
    // someone who already reads English.
    expect(btns.map((b) => b.textContent)).toEqual(['English', '한국어']);
  });

  it('CONTRACT: the labels are NOT translated — the ko surface still says "English", the en surface still says "한국어"', () => {
    for (const initialLocale of ['en', 'ko'] as const) {
      act(() => {
        root.render(
          <I18nProvider initialLocale={initialLocale}>
            <LocaleSwitcher />
          </I18nProvider>,
        );
      });
      expect(buttons().map((b) => b.textContent), initialLocale).toEqual(['English', '한국어']);
    }
  });

  it('UI: the Hangul label carries neither the mono face nor Latin tracking (both read as broken kerning on Hangul)', () => {
    render();
    const [en, ko] = buttons();
    expect(en.style.fontFamily).toBe('var(--font-mono)');
    expect(en.style.letterSpacing).toBe('0.02em');
    expect(ko.style.fontFamily).toBe('var(--font-sans)');
    expect(ko.style.letterSpacing).toBe('normal');
  });

  it('UI: neither label may wrap mid-word inside a narrow container (drawer/header are both tight)', () => {
    render();
    for (const b of buttons()) expect(b.style.whiteSpace).toBe('nowrap');
  });

  it('CONTRACT: the active locale is aria-pressed, the other is not', () => {
    render();
    const [en, ko] = buttons();
    expect(en.getAttribute('aria-pressed')).toBe('true');
    expect(ko.getAttribute('aria-pressed')).toBe('false');
  });

  it('CONTRACT: clicking the inactive locale switches which button is pressed', () => {
    render();
    const [en, ko] = buttons();

    act(() => {
      ko.click();
    });

    expect(en.getAttribute('aria-pressed')).toBe('false');
    expect(ko.getAttribute('aria-pressed')).toBe('true');
  });

  it('is wrapped in a labelled group for accessibility', () => {
    render();
    expect(container.querySelector('[role="group"][aria-label="Language"]')).not.toBeNull();
  });
});
