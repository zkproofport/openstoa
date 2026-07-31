// @vitest-environment jsdom
/**
 * The theme is a remembered CHOICE, not the operating system's preference.
 *
 * Reported: "배경색이 시스템설정에 의해서 바뀌도록 되어 있어? 근데 설정 변경이 안되네" —
 * the site followed macOS and offered no control of its own, while the mobile
 * mini-app takes its mode from the host app and ignores the device entirely
 * (`packages/mobile/src/theme/ThemeContext.tsx`). One product behaving two ways.
 *
 * What these pin:
 *   1. the OS preference no longer decides — `prefers-color-scheme` is scoped
 *      so it cannot override an explicit choice;
 *   2. the choice survives a reload;
 *   3. the pre-paint script applies it BEFORE first paint (no flash), which is
 *      why it is an inline script and not a React effect;
 *   4. storage being unavailable degrades to the default instead of throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import en from '@/lib/i18n/locales/en.json';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  currentTheme,
  isTheme,
  readStoredTheme,
  writeStoredTheme,
} from '@/lib/theme';
import ThemeToggle from '@/components/ThemeToggle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf-8');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ThemeToggle />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

const button = () => container.querySelector('button');

describe('theme store', () => {
  it('defaults to dark — the mode every surface is known to render correctly in', () => {
    expect(DEFAULT_THEME).toBe('dark');
  });

  it('round-trips a choice through storage', () => {
    expect(readStoredTheme()).toBeNull();
    writeStoredTheme('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('rejects a junk stored value instead of stamping it onto <html>', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
    expect(readStoredTheme()).toBeNull();
    expect(isTheme('chartreuse')).toBe(false);
  });

  it('EXTERNAL FAILURE: storage throwing degrades to the default, never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => writeStoredTheme('light')).not.toThrow();
    expect(currentTheme()).toBe(DEFAULT_THEME);
  });

  it('currentTheme reads the DOM, so the toggle starts from what is actually shown', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(currentTheme()).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('switches the attribute and persists the choice', async () => {
    applyTheme('dark');
    await mount();

    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('is named for the destination, so its purpose is unambiguous', async () => {
    applyTheme('dark');
    await mount();
    // Dark is active → pressing it brings light.
    expect(button()!.getAttribute('aria-label')).toBe(en.common.themeToLight);

    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(button()!.getAttribute('aria-label')).toBe(en.common.themeToDark);
  });

  it('toggles back, and the second choice is the one remembered', async () => {
    applyTheme('dark');
    await mount();
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        button()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('no flash of the wrong theme, and no OS override', () => {
  it('CONTRACT: the theme is applied by an inline pre-paint script, not an effect', () => {
    const layout = source('src/app/layout.tsx');
    expect(layout).toContain('theme-init');
    expect(layout).toContain('dangerouslySetInnerHTML');
    // Reads the same key the store writes — a mismatch here is a silent flash.
    expect(layout).toContain(THEME_STORAGE_KEY);
    // <html> is mutated before hydration, so React must be told to expect it.
    expect(layout).toContain('suppressHydrationWarning');
  });

  it('CONTRACT: prefers-color-scheme cannot override an explicit choice', () => {
    const css = source('src/app/globals.css');
    // Scoped to elements with NO data-theme — so once the script stamps one,
    // the OS block stops applying entirely.
    expect(css).toContain(':root:not([data-theme])');
    // And both explicit themes still exist to be chosen.
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain(":root[data-theme='light']");
  });

  it('the inline script falls back to the default when storage is unreadable', () => {
    // The script is authored as concatenated string literals for readability,
    // so rejoin them before matching — otherwise this asserts formatting
    // rather than behaviour and breaks on any harmless re-wrap.
    const script = source('src/app/layout.tsx').replace(/"\s*\+\s*"/g, '');
    // A try/catch that still stamps an attribute: a blocked localStorage must
    // leave the page on the default theme, not on no theme at all.
    expect(script).toContain(`catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}')`);
  });
});
