'use client';

/**
 * Light/dark switch.
 *
 * Until now the theme was whatever macOS said, and the app offered no way to
 * change it — while the mobile mini-app takes its mode from the host app and
 * ignores the OS entirely (`packages/mobile/src/theme/ThemeContext.tsx`). This
 * makes the web behave like the app: an explicit choice, remembered.
 *
 * Rendered beside `LocaleSwitcher` in `Header.tsx` — both are preferences that
 * apply to guests and signed-in users alike.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { applyTheme, currentTheme, writeStoredTheme, type Theme } from '@/lib/theme';
import { MoonIcon, SunIcon } from '@/components/icons';

export default function ThemeToggle({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  // Starts at null, not at a guessed theme: the real value lives on <html>,
  // written by the pre-paint script, and the server has no way to know it.
  // Rendering a guess would flip the icon on hydration.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  // Reserve the footprint so the header does not reflow when the theme
  // resolves. `className` is carried here too: the header hides this control
  // at phone widths via a class, and a placeholder that ignored it would
  // reserve 44px of nothing in a row that is supposed to be empty.
  if (theme === null) {
    return <span className={className} style={{ width: 'var(--touch-target-min)', height: 'var(--touch-target-min)', ...style }} />;
  }

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = t(next === 'light' ? 'common.themeToLight' : 'common.themeToDark');

  return (
    <button
      type="button"
      className={`os-header-btn${className ? ` ${className}` : ''}`}
      // The control's job is "switch to the other one", so it is named for the
      // destination, not the current state — and the title matches the label so
      // hover and screen reader agree.
      aria-label={label}
      title={label}
      onClick={() => {
        applyTheme(next);
        writeStoredTheme(next);
        setTheme(next);
      }}
      style={style}
    >
      {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  );
}
