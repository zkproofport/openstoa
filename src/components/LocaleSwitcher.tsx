'use client';

/**
 * FIX6: the `NEXT_LOCALE` cookie / `I18nProvider.setLocale()` mechanism has
 * existed since the i18n scaffold landed, but no UI ever called it — the
 * Korean catalogue was unreachable. Two locales only (`en` / `ko`, see
 * `SUPPORTED_LOCALES` in `src/lib/i18n/index.ts`).
 *
 * Rendered in two places, both wired to the SAME `useTranslation()` state
 * (no separate switcher state to keep in sync): `Header.tsx` (reachable from
 * every page, signed in or not — language is not an auth-gated preference)
 * and `/my`'s Settings tab (the account/settings area a signed-in user
 * would also look for it in).
 */
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

const LOCALE_LABELS: Record<Locale, string> = { en: 'EN', ko: 'KO' };

export default function LocaleSwitcher({ style }: { style?: React.CSSProperties }) {
  const { locale, setLocale, t } = useTranslation();
  return (
    <div role="group" aria-label={t('common.language')} style={{ display: 'inline-flex', gap: 2, ...style }}>
      {SUPPORTED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code)}
          aria-pressed={locale === code}
          style={{
            background: locale === code ? 'rgba(120,140,255,0.14)' : 'transparent',
            color: locale === code ? 'var(--accent)' : '#999',
            border: `1px solid ${locale === code ? 'rgba(120,140,255,0.3)' : 'transparent'}`,
            borderRadius: 'var(--radius-control)',
            padding: '4px 8px',
            fontSize: 'var(--text-label)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            letterSpacing: '0.02em',
            cursor: 'pointer',
          }}
        >
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
