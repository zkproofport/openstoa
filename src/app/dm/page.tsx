'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Avatar from '@/components/Avatar';
import Spinner from '@/components/Spinner';
import { relativeTime } from '@/lib/utils';
import { sortDmChannels, type DmChannel } from '@/lib/dm';

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
  gap: 12,
  padding: '12px 16px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  textDecoration: 'none',
  transition: 'background 0.12s',
};

export default function DmListPage() {
  const router = useRouter();

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
      if (!res.ok) throw new Error('Failed to load messages');
      const data = await res.json();
      setDms(sortDmChannels(data.dms ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadDms();
  }, [loadDms]);

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '36px 1.5rem 80px' }}>
        <h1 style={{
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '-0.03em',
          margin: '0 0 4px',
          color: 'var(--foreground)',
        }}>
          Messages
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 24px', fontFamily: 'var(--font-mono)' }}>
          End-to-end encrypted 1:1 conversations
        </p>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
            <Spinner />
          </div>
        )}

        {!loading && needsNickname && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 12px' }}>
              Set a nickname before you can send direct messages.
            </p>
            <Link href="/profile?returnTo=%2Fdm" style={{ color: 'var(--accent)', fontSize: 14 }}>
              Go to profile
            </Link>
          </div>
        )}

        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 14, margin: '0 0 12px' }}>
              {error}
            </p>
            <button
              onClick={() => loadDms()}
              style={{
                background: 'rgba(120,140,255,0.1)',
                color: 'var(--accent)',
                border: '1px solid rgba(120,140,255,0.2)',
                borderRadius: 6,
                padding: '6px 16px',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && !needsNickname && dms.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 8px' }}>
              No direct messages
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
              Open a topic&rsquo;s member list and pick Message to start a 1:1 conversation.
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
                  fontSize: 15,
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
                    fontSize: 11,
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
