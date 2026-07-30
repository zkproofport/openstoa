'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale, translate, type Locale } from './index';

interface I18nContextValue {
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLocale: (next: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function writeCookie(locale: Locale) {
  // 1 year, matches the intent of a persistent user preference. `samesite=lax`
  // is enough since this cookie only ever affects rendering, never auth.
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  /** Resolved server-side (`getServerLocale()`) from the same cookie this
   *  provider reads on the client, so the first client render matches the
   *  server render exactly — no hydration mismatch. */
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    isSupportedLocale(initialLocale) ? initialLocale : DEFAULT_LOCALE,
  );

  const setLocale = useCallback((next: Locale) => {
    if (!isSupportedLocale(next)) return; // never adopt an invalid locale
    setLocaleState(next);
    writeCookie(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  );

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * `t(key, params?)` + `locale` + `setLocale`. Must be used within
 * `I18nProvider` (mounted once in `src/app/layout.tsx`) — throws early and
 * loudly on a missing provider so a forgotten wrap is caught in dev, not
 * shipped as silently-untranslated text.
 */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation() must be used within an <I18nProvider>');
  }
  return ctx;
}
