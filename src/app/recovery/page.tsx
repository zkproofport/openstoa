'use client';

/**
 * Persistent E2EE chat-recovery settings page (Phase 4). Unlike /profile — which
 * is a one-time onboarding page that redirects away once a nickname is set — this
 * page stays reachable for logged-in users to manage their recovery backups
 * (register a passkey, generate a recovery code) and to recover on a fresh device.
 * Session required (middleware redirects guests to login); no nickname required.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { AccountRecovery } from '@/components/AccountRecovery';

export default function RecoveryPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>('You');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session')
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
      <div style={{ minHeight: 'calc(100vh - 73px)', display: 'flex', justifyContent: 'center', padding: '40px 1.5rem' }}>
        <div style={{ width: '100%', maxWidth: 520 }}>
          {loaded && userId ? (
            <AccountRecovery userId={userId} displayName={nickname} />
          ) : (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>
          )}
        </div>
      </div>
    </>
  );
}
