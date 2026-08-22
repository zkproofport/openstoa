'use client';

/**
 * Persistent E2EE chat-recovery settings page (Phase 4). Unlike /profile — which
 * is a one-time onboarding page that redirects away once a nickname is set — this
 * page stays reachable for logged-in users to manage their recovery backups
 * (register a passkey, generate a recovery code) and to recover on a fresh device.
 * Session required (middleware redirects guests to login); no nickname required.
 *
 * Standalone chrome: `<Header />` and nothing else — no `CommunityLayout`, so no
 * sidebar, no tab bar, no chat rail. Everything the reader needs to get back
 * out (the mark in the header, and the explicit link below it) has to be on
 * this page itself.
 */
import { apiFetch } from '@/lib/apiFetch';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import { AccountRecovery } from '@/components/AccountRecovery';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export default function RecoveryPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>('You');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.userId) {
          router.replace('/');
          return;
        }
        setUserId(data.userId);
        if (data.nickname) setNickname(data.nickname);
        setLoaded(true);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  return (
    <>
      <Header />
      {/* 73px = standalone <Header /> rendered height (not a design token; matches
          the same literal in profile/page.tsx and topics/[topicId]/join/page.tsx). */}
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          justifyContent: 'center',
          padding: 'var(--space-6) var(--space-5) var(--space-7)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 'var(--read-max)' }}>
          {/* The way back. `/my`'s Settings tab is where this page is
              discovered from, and this page has no nav of its own. */}
          <Link
            href="/my"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              minHeight: 'var(--touch-target-min)',
              fontSize: 'var(--text-body-sm)',
              color: 'var(--color-text-secondary)',
              textDecoration: 'none',
              marginBottom: 'var(--space-3)',
            }}
          >
            ← {t('accountRecovery.backToSettings')}
          </Link>

          {loaded && userId ? (
            <AccountRecovery userId={userId} displayName={nickname} />
          ) : (
            <p style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--text-body-sm)' }}>{t('common.loading')}</p>
          )}
        </div>
      </div>
    </>
  );
}
