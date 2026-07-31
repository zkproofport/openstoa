/**
 * The app's theme is a CHOICE, not the operating system's preference.
 *
 * The mobile mini-app reads its mode from the host app
 * (`packages/mobile/src/theme/ThemeContext.tsx` -> `host.getTheme()`) and never
 * from the device. Web and mobile are one product, so the site behaving
 * differently from the app it embeds into would be two behaviours wearing one
 * brand. `prefers-color-scheme` is therefore not consulted here.
 *
 * The value lives on `<html data-theme>`; `globals.css` resolves every token
 * from that attribute. `THEME_STORAGE_KEY` is read by an inline script before
 * first paint (see `ThemeScript` in `layout.tsx`) — keep the key and the
 * accepted values in sync with it.
 */
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'openstoa.theme';

/**
 * Dark, matching the base `:root` block in globals.css.
 *
 * Not an aesthetic preference: the app was built dark, so dark is the mode
 * every surface is known to render correctly in. A first-time visitor should
 * land on the one that is verified, and choose the other deliberately.
 */
export const DEFAULT_THEME: Theme = 'dark';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** The saved choice, or null when none has been made (or storage is blocked). */
export function readStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    // Private browsing / storage disabled — the caller falls back to the
    // default rather than failing to render.
    return null;
  }
}

export function writeStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the theme still applies for this page's lifetime, it just
    // will not survive a reload.
  }
}

/** Stamp the attribute the CSS resolves against. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** What the DOM currently says, so the toggle starts from the truth. */
export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return isTheme(attr) ? attr : DEFAULT_THEME;
}
