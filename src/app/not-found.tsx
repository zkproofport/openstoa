'use client';

/**
 * A wrong address used to land on Next.js's built-in page: white background,
 * black "404", no header, no way back. Seen on 2026-08-29 while walking the
 * site in a browser — and it is not only a typo that gets you there. A link to
 * a topic somebody deleted lands here too, and the person following it is told
 * nothing about what happened or where to go.
 *
 * Its own copy of the header and shell would drift from the real one, so this
 * borrows nothing and states the two useful things: the page is not here, and
 * this is the way back.
 */
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export default function NotFound() {
  const { t } = useTranslation();

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-6)',
        textAlign: 'center',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      <h1 style={{ fontSize: 'var(--text-heading-lg)', fontWeight: 800, letterSpacing: '-0.04em', margin: 0 }}>
        {t('notFound.title')}
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-body)', margin: 0, maxWidth: 420, lineHeight: 1.6 }}>
        {t('notFound.body')}
      </p>
      <Link
        href="/"
        style={{
          marginTop: 'var(--space-2)',
          background: 'var(--accent)',
          color: 'var(--color-text-inverted)',
          borderRadius: 'var(--radius-control)',
          padding: 'var(--space-3) var(--space-6)',
          fontSize: 'var(--text-body)',
          fontWeight: 700,
          textDecoration: 'none',
          minHeight: 'var(--touch-target-min)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {t('notFound.backHome')}
      </Link>
    </main>
  );
}
