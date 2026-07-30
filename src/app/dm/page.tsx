'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Avatar from '@/components/Avatar';
import Spinner from '@/components/Spinner';
import { relativeTime } from '@/lib/utils';
import { sortDmChannels, type DmChannel } from '@/lib/dm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/**
 * Direct messages list — the web counterpart of the mobile DmListScreen
 * (packages/mobile/src/screens/chat/DmListScreen.tsx). Deliberately the SAME
 * information model so the two surfaces agree: the peer's identity plus a
 * last-activity timestamp, most-recently-active first.
 *
 * SI-1: `GET /api/dm` carries routing metadata ONLY — no message body and no
 * decrypted preview. Plaintext exists only inside the MLS session opened by the
 * conversation view, so this page holds no crypto and never touches one.
 */

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  textDecoration: 'none',
  transition: 'background 0.12s',
};

export default function DmListPage() {
  const router = useRouter();
  const { t } = useTranslation();

  const [dms, setDms] = useState<DmChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A session with a temp `anon_` nickname is rejected by /api/dm with 403.
  // Surface the real remedy (set a nickname) instead of a dead error string.
  const [needsNickname, setNeedsNickname] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) { router.replace('/'); return; }
      })
      .catch(() => router.replace('/'));
  }, [router]);

  const loadDms = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsNickname(false);
    try {
      const res = await fetch('/api/dm');
      if (res.status === 401) { router.replace('/'); return; }
      if (res.status === 403) { setNeedsNickname(true); return; }
      if (!res.ok) throw new Error(t('dmPage.loadError'));
      const data = await res.json();
      setDms(sortDmChannels(data.dms ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dmPage.loadError'));
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    loadDms();
  }, [loadDms]);

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {/* maxWidth/36px/80px are page-shell layout constants with no matching
          space-scale step; kept literal to avoid shifting the column width. */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '36px var(--space-5) 80px' }}>
        <h1 style={{
          fontSize: 'var(--text-heading-sm)',
          fontWeight: 800,
          letterSpacing: '-0.03em',
          margin: '0 0 var(--space-1)',
          color: 'var(--foreground)',
        }}>
          {t('dmPage.title')}
        </h1>
        <p style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: '0 0 var(--space-5)', fontFamily: 'var(--font-mono)' }}>
          {t('dmPage.subtitle')}
        </p>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
            <Spinner />
          </div>
        )}

        {!loading && needsNickname && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 var(--space-3)' }}>
              {t('dmPage.needsNickname')}
            </p>
            <Link href="/profile?returnTo=%2Fdm" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
              {t('dmPage.goToProfile')}
            </Link>
          </div>
        )}

        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-3)' }}>
              {error}
            </p>
            <button
              onClick={() => loadDms()}
              style={{
                background: 'rgba(120,140,255,0.1)',
                color: 'var(--accent)',
                border: '1px solid rgba(120,140,255,0.2)',
                borderRadius: 'var(--radius-control)',
                padding: '6px var(--space-4)',
                fontSize: 'var(--text-body-sm)',
                fontWeight: 500,
                cursor: 'pointer',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        {!loading && !error && !needsNickname && dms.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: 'var(--foreground)', margin: '0 0 var(--space-2)' }}>
              {t('dmPage.empty.title')}
            </p>
            <p style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
              {t('dmPage.empty.body')}
            </p>
          </div>
        )}

        {!loading && !error && !needsNickname && dms.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {dms.map((dm) => (
              <Link
                key={dm.topicId}
                href={`/dm/${dm.topicId}`}
                data-testid="dm-row"
                style={rowStyle}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; }}
              >
                <Avatar src={dm.peer.profileImage} name={dm.peer.nickname} size={40} />
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'var(--text-body)',
                  fontWeight: 600,
                  color: 'var(--foreground)',
                  // Layout-only truncation: a very long nickname must not push
                  // the timestamp out of the row.
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {dm.peer.nickname}
                </span>
                {dm.lastActivityAt && (
                  <span style={{
                    fontSize: 'var(--text-caption)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)',
                    flexShrink: 0,
                  }}>
                    {relativeTime(dm.lastActivityAt)}
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </CommunityLayout>
  );
}
