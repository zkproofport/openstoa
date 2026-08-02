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

/**
 * Each locale is named IN ITS OWN LANGUAGE, and never translated — a Korean
 * speaker who has landed on the English surface has to be able to recognise
 * the way out, which the previous "EN" / "KO" did not give them: those are
 * English abbreviations of language names, so the control that switches away
 * from English was itself only readable in English. (`한국어` therefore stays
 * `한국어` under the `en` locale, and `English` stays `English` under `ko`;
 * this is why the labels are a constant here rather than i18n keys.)
 */
const LOCALE_LABELS: Record<Locale, string> = { en: 'English', ko: '한국어' };

export default function LocaleSwitcher({ style }: { style?: React.CSSProperties }) {
  const { locale, setLocale, t } = useTranslation();
  return (
    <div role="group" aria-label={t('common.language')} style={{ display: 'inline-flex', gap: 2, ...style }}>
      {SUPPORTED_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          className="os-locale-btn"
          onClick={() => setLocale(code)}
          aria-pressed={locale === code}
          style={{
            background: locale === code ? 'var(--color-brand-primary-muted)' : 'transparent',
            color: locale === code ? 'var(--accent)' : 'var(--color-text-tertiary)',
            border: `1px solid ${locale === code ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'transparent'}`,
            borderRadius: 'var(--radius-control)',
            padding: '4px 8px',
            fontSize: 'var(--text-label)',
            // Per-BUTTON, not per-active-locale: each button's label is
            // written in its own script, so the mono face + tracking (a
            // Latin-label idiom — `.os-label:lang(en)` in globals.css exists
            // for exactly this reason) applies to "English" and never to
            // "한국어", where IBM Plex Mono has no Hangul coverage anyway and
            // tracking reads as broken kerning.
            fontFamily: code === 'ko' ? 'var(--font-sans)' : 'var(--font-mono)',
            fontWeight: 600,
            letterSpacing: code === 'ko' ? 'normal' : '0.02em',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
