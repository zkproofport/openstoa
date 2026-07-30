// @vitest-environment jsdom
/**
 * `I18nProvider` / `useTranslation()` — the client half of the i18n scaffold.
 *
 * Edge-case matrix covered here:
 *   contract — useTranslation() outside a provider throws immediately (not a
 *              silently-untranslated page)
 *   boundary — invalid initialLocale prop clamps to DEFAULT_LOCALE instead
 *              of adopting garbage
 *   contract — setLocale('fr') (unsupported) is a no-op — never adopted
 *   contract — setLocale('ko') persists to document.cookie so the server
 *              read on next navigation matches
 *   ui       — t() re-renders consumers with the new locale's strings after
 *              setLocale
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, useTranslation } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0'; // clear
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function Probe() {
  const { locale, t, setLocale } = useTranslation();
  // Constructed the same way a corrupted cookie value would arrive at
  // runtime (as an arbitrary string, not a value TS could narrow) — this is
  // the honest way to exercise the runtime guard without relying on a
  // `@ts-expect-error` pragma, which doesn't suppress inside a JSX
  // `{/* ... */}` comment container.
  const invalidLocale = 'fr' as unknown as Locale;
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="label">{t('sidebar.categories')}</span>
      <button data-testid="to-ko" onClick={() => setLocale('ko')}>ko</button>
      <button data-testid="to-invalid" onClick={() => setLocale(invalidLocale)}>invalid</button>
    </div>
  );
}

function render(initialLocale: Locale) {
  act(() => {
    root.render(
      <I18nProvider initialLocale={initialLocale}>
        <Probe />
      </I18nProvider>,
    );
  });
}

describe('useTranslation outside a provider', () => {
  it('throws immediately rather than silently rendering untranslated text', () => {
    const OutsideProvider = () => {
      useTranslation();
      return null;
    };
    // React logs the error to console during the throwing render; suppress
    // that expected noise for this one assertion.
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => {
        act(() => {
          root.render(<OutsideProvider />);
        });
      }).toThrow(/useTranslation\(\) must be used within an <I18nProvider>/);
    } finally {
      console.error = originalError;
    }
  });
});

describe('I18nProvider', () => {
  it('renders with the given initialLocale and resolves t() against it', () => {
    render('ko');
    expect(container.querySelector('[data-testid="locale"]')?.textContent).toBe('ko');
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe('카테고리');
  });

  it('invalid initialLocale clamps to DEFAULT_LOCALE instead of adopting garbage', () => {
    // @ts-expect-error deliberately invalid prop to verify the runtime guard
    render('fr');
    expect(container.querySelector('[data-testid="locale"]')?.textContent).toBe('en');
  });

  it('setLocale to a supported locale re-renders consumers and persists to document.cookie', () => {
    render('en');
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe('Categories');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="to-ko"]')?.click();
    });

    expect(container.querySelector('[data-testid="locale"]')?.textContent).toBe('ko');
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe('카테고리');
    expect(document.cookie).toContain('NEXT_LOCALE=ko');
  });

  it('setLocale to an unsupported locale is a no-op — state and cookie stay put', () => {
    render('en');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="to-invalid"]')?.click();
    });

    expect(container.querySelector('[data-testid="locale"]')?.textContent).toBe('en');
    expect(document.cookie).not.toContain('NEXT_LOCALE=fr');
  });
});
