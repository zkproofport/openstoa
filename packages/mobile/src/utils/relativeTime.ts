import i18n from 'i18next';

/**
 * formatRelativeTime — converts an ISO 8601 string to a translated
 * relative-time label, e.g. "5m ago" / "5m jeon" (Korean).
 * Reads the current language from the shared i18next instance.
 */
export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return i18n.t('openstoa.relativeTime.justNow');

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return i18n.t('openstoa.relativeTime.minutes', { n: diffMin });

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return i18n.t('openstoa.relativeTime.hours', { n: diffHour });

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return i18n.t('openstoa.relativeTime.days', { n: diffDay });

  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return i18n.t('openstoa.relativeTime.months', { n: diffMonth });

  const diffYear = Math.floor(diffMonth / 12);
  return i18n.t('openstoa.relativeTime.years', { n: diffYear });
}
