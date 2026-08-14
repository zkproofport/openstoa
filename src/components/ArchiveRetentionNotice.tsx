'use client';

/**
 * What this topic does with its chat history, said to the members who live with
 * the consequence.
 *
 * The window is chosen once, by the admin, at creation — so everyone else finds
 * out only if the interface tells them. A member who scrolls up and hits a wall
 * should be able to learn that the wall is a setting, not a bug, and a member
 * about to say something they expect to be permanent should be able to see that
 * it is not.
 *
 * The copy and the choice both come from `src/lib/archiveRetention.ts`, which
 * the mini-app shares byte for byte, so the two clients cannot describe the same
 * number differently.
 */
import { archiveRetentionKey, isUnlimitedRetention } from '@/lib/archiveRetention';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface Props {
  /** `topics.chatArchiveRetentionDays`. 0 (or an absent value) is unlimited. */
  days: number | undefined | null;
}

export default function ArchiveRetentionNotice({ days }: Props) {
  const { t } = useTranslation();
  // Absent is unlimited, not unknown: every topic that predates the setting has
  // an unbounded archive, and a client on an older payload must not imply that
  // something is being deleted.
  const window = typeof days === 'number' ? days : 0;

  return (
    <span
      className="os-label"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        color: 'var(--color-text-secondary)',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-control)',
        padding: '1px 6px',
        lineHeight: 1.2,
      }}
      title={
        isUnlimitedRetention(window)
          ? t('topicPage.archiveRetention.titleUnlimited')
          : t('topicPage.archiveRetention.titleWindowed')
      }
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
      {t(`topicPage.archiveRetention.${archiveRetentionKey(window)}`)}
    </span>
  );
}
