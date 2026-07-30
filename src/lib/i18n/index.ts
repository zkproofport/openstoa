/**
 * Web i18n scaffold — plain nested-JSON dictionaries + dot-path lookup, no
 * routing dependency. See `src/app/layout.tsx` (server: resolves the active
 * locale + sets `<html lang>`) and `I18nProvider.tsx` (client: React context
 * + `useTranslation()`).
 *
 * Why a hand-rolled scaffold instead of next-intl / react-i18next: this app
 * has no locale-prefixed routing (session-cookie auth, not tenant routing)
 * and leans heavily on React Server Components (`generateMetadata`,
 * `force-dynamic` pages). react-i18next needs client-side init and doesn't
 * compose with RSCs; next-intl is the "right" long-term answer but is a
 * routing-aware dependency this scaffold doesn't need yet — adding it now,
 * before any page actually needs per-locale routes, would be premature. A
 * ~100-line context + JSON lookup is enough to prove the pattern end to end;
 * swapping to next-intl later is a contained change (the JSON dictionaries
 * and key naming already match what it expects).
 *
 * Key naming reuses `packages/mobile/src/i18n/locales/en.json`'s convention
 * (nested-by-screen namespaces, camelCase leaves, `{{var}}` interpolation)
 * so the two catalogues can converge later instead of diverging. `common.*`
 * keys are copied verbatim (same keys, same EN/KO values) as a convergence
 * seed even though no web surface consumes them yet.
 */
import en from './locales/en.json';
import ko from './locales/ko.json';

export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie written by a future locale switcher; read server-side in layout.tsx. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dictionary = Record<string, any>;

const DICTIONARIES: Record<Locale, Dictionary> = { en, ko };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/** Type guard — never throws. Anything not in SUPPORTED_LOCALES is rejected. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Pure resolver for a raw cookie value -> validated Locale. Split out from
 * any `next/headers` call so it's trivially unit-testable without mocking
 * the Next.js server runtime. Unknown/missing/garbage input -> DEFAULT_LOCALE,
 * never throws.
 */
export function resolveLocale(rawCookieValue: string | undefined | null): Locale {
  return isSupportedLocale(rawCookieValue) ? rawCookieValue : DEFAULT_LOCALE;
}

/**
 * Dot-path lookup, e.g. "sidebar.stats.topics". Missing segments -> undefined.
 * Exported (not just used internally by `translate`) so both branches —
 * missing-key and key-resolves-to-a-non-string-namespace-object — are
 * directly unit-testable without depending on the shape of the seeded
 * dictionaries.
 */
export function lookupKey(dict: Dictionary, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in (node as Dictionary)) {
      return (node as Dictionary)[segment];
    }
    return undefined;
  }, dict);
}

/** `{{var}}` interpolation. Missing params are left as the literal `{{var}}` token. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Resolves `key` against `locale`'s dictionary, falling back to
 * DEFAULT_LOCALE's dictionary if missing there too, and finally to the raw
 * key path if missing everywhere. Never throws — a missing key is a visible-
 * but-non-fatal bug (the key path renders in place of copy) rather than a
 * crashed page.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const primary = lookupKey(getDictionary(locale), key);
  if (typeof primary === 'string') return interpolate(primary, params);

  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookupKey(getDictionary(DEFAULT_LOCALE), key);
    if (typeof fallback === 'string') return interpolate(fallback, params);
  }

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
  }
  return key;
}
