'use client';

/**
 * FIX6: the `NEXT_LOCALE` cookie / `I18nProvider.setLocale()` mechanism has
 * existed since the i18n scaffold landed, but no UI ever called it — the
 * Korean catalogue was unreachable. Two locales only (`en` / `ko`, see
 * `SUPPORTED_LOCALES` in `src/lib/i18n/index.ts`).
 *
 * Rendered in three places, all wired to the SAME `useTranslation()` state
 * (no separate switcher state to keep in sync): `Header.tsx`, the drawer's
 * Preferences group (`LeftSidebar.tsx`) and `/my`'s Settings tab — language
 * is not an auth-gated preference, so it is reachable signed in or not.
 *
 * ── Why a <select> and not two buttons ───────────────────────────────────
 * The original pair of toggle buttons spent the width of BOTH language names
 * permanently, in a header row that also carries a hamburger, a logo, a theme
 * toggle and a session chip. At phone widths that is the single most
 * expensive control in the row for the least information: only one of the two
 * is ever actionable, since the active one is a no-op. A `<select>` spends
 * the width of one name and folds the alternative into the native menu, which
 * is also the affordance the platform already gives users for "pick one of a
 * short list".
 */
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { SUPPORTED_LOCALES, isSupportedLocale, type Locale } from '@/lib/i18n';

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

export default function LocaleSwitcher({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const { locale, setLocale, t } = useTranslation();
  return (
    <select
      className={`os-locale-select${className ? ` ${className}` : ''}`}
      // No visible <label> exists in any of the three mount points (the header
      // row and the drawer row are icon-dense control strips; `/my`'s heading
      // is a section heading, not a label element), so the accessible name has
      // to come from here. `common.language` IS translated — unlike the option
      // labels, this one is read by a user who already reads the current
      // surface's language.
      aria-label={t('common.language')}
      value={locale}
      onChange={(e) => {
        // The option list is generated from SUPPORTED_LOCALES, so a browser
        // cannot submit anything else — but `e.target.value` is typed `string`
        // and the alternative is an `as Locale` cast that would launder any
        // future bug (a hand-added <option>, a testing-library dispatch) into
        // an invalid locale. `I18nProvider.setLocale` rejects it too; this is
        // the same check at the boundary that produces the value.
        if (isSupportedLocale(e.target.value)) setLocale(e.target.value);
      }}
      style={style}
    >
      {SUPPORTED_LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_LABELS[code]}
        </option>
      ))}
    </select>
  );
}
