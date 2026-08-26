'use client';

import { CHAT_ON_WEB } from '@/lib/chatOnWeb';
import ChatNotOnWeb from '@/components/ChatNotOnWeb';
import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Avatar from '@/components/Avatar';
import Spinner from '@/components/Spinner';
import { rowStyle, emptyStateStyle } from '@/components/ChatRoomList';
import { relativeTime } from '@/lib/utils';
import { sortDmChannels, type DmChannel } from '@/lib/dm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/**
 * Direct messages list — the web counterpart of the mobile DmListScreen
 * (packages/mobile/src/screens/chat/DmListScreen.tsx). Deliberately the SAME
 * information model so the two surfaces agree: the peer's identity plus a
 * last-activity timestamp, most-recently-active first.
 *
 * The row TREATMENT is the chat rail's, imported rather than re-invented:
 * `rowStyle` / `emptyStateStyle` come from `ChatRoomList.tsx`, which the rail
 * and the standalone `/chat` list both render. The same conversation seen in
 * the rail and on this page has to look like one thing — a bordered card here
 * and a rule-separated row there read as two different products. (The row is
 * an `<a>` here and a `<button>` in the rail because this page navigates and
 * the rail opens in place; that is the one intended difference.)
 *
 * SI-1: `GET /api/dm` carries routing metadata ONLY — no message body and no
 * decrypted preview. Plaintext exists only inside the MLS session opened by the
 * conversation view, so this page holds no crypto and never touches one. The
 * second line of a row is therefore a LOCKED PLACEHOLDER, never content —
 * identical to `RoomRow` in `ChatRoomList.tsx`, for the same reason.
 */

export default function DmListPage() {
  /*
   * Chat is not on the web — `lib/chatOnWeb.ts` says why, and the rail that used
   * to list rooms is gated on the same constant. Hiding the buttons and leaving
   * this page reachable would not be a gate: the rail's own "open in new tab"
   * target is this URL, and it is in people's history and bookmarks.
 *
   * Nothing below is deleted. When the mobile-app notice comes back, flip
   * `CHAT_ON_WEB` and this early return goes with it.
   */
  if (!CHAT_ON_WEB) {
    return <ChatNotOnWeb />;
  }

  const router = useRouter();
  const { t } = useTranslation();

  const [dms, setDms] = useState<DmChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Kept as a safety net, not as a workflow — see /chat. The nickname gate
  // that used to 403 this call is gone.
  const [needsNickname, setNeedsNickname] = useState(false);

  /*
   * Gated on `isVerified`, not on the value.
   *
   * A seeded session is a hint; a redirect is not something to do on a hint,
   * and neither is redirecting because the answer has not arrived yet. The
   * previous code only ever ran after the fetch settled, and this keeps that:
   * it acts once the server has answered, and a failed lookup answers `null`.
   */
  const { session, isVerified } = useSession();
  useEffect(() => {
    if (isVerified && !session?.userId) router.replace('/');
  }, [isVerified, session, router]);

  const loadDms = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsNickname(false);
    try {
      const res = await apiFetch('/api/dm');
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
      {/* 560px is a list measure, narrower than the page's own --read-max prose
          cap: these rows are scanned, not read, and a name + timestamp stretched
          across 860px puts the two ends of one row out of each other's reach. */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--space-6) 0 var(--space-7)' }}>
        {/* Identity block — heading step, weight and tracking match the feed and
            Explore (all three are CommunityLayout pages), and the sub-line is
            `.os-label`, the same subtitle idiom the chat rail and the popped-out
            /chat page use. */}
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <h1 style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            margin: '0 0 var(--space-1)',
            color: 'var(--color-text-primary)',
          }}>
            {t('dmPage.title')}
          </h1>
          <div className="os-label" style={{ color: 'var(--color-text-secondary)' }}>
            {t('dmPage.subtitle')}
          </div>
        </div>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
            <Spinner />
          </div>
        )}

        {!loading && needsNickname && (
          <div style={emptyStateStyle}>
            <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-body-sm)' }}>
              {t('dmPage.needsNickname')}
            </p>
            <Link href="/profile?returnTo=%2Fdm" className="os-button">
              {t('dmPage.goToProfile')}
            </Link>
          </div>
        )}

        {/* Error is a DISTINCT state from empty, not a red variant of it: a
            failed request that renders an empty list tells the reader they have
            no conversations, which is a different and wrong fact. */}
        {!loading && error && (
          <div
            role="alert"
            style={{
              textAlign: 'center',
              padding: 'var(--space-7) var(--space-5)',
              border: '1px solid var(--color-status-danger)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <p style={{
              color: 'var(--color-status-danger)',
              fontSize: 'var(--text-body-lg)',
              fontWeight: 600,
              margin: '0 0 var(--space-2)',
            }}>
              {error}
            </p>
            <p style={{
              fontSize: 'var(--text-body-sm)',
              color: 'var(--color-text-secondary)',
              margin: '0 0 var(--space-5)',
            }}>
              {t('dmPage.errorBody')}
            </p>
            <button type="button" onClick={() => loadDms()} className="os-button os-button-primary">
              {t('common.retry')}
            </button>
          </div>
        )}

        {!loading && !error && !needsNickname && dms.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={{
              fontSize: 'var(--text-body-lg)',
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              margin: '0 0 var(--space-2)',
              letterSpacing: '-0.02em',
            }}>
              {t('dmPage.empty.title')}
            </p>
            <p style={{ margin: 0 }}>{t('dmPage.empty.body')}</p>
          </div>
        )}

        {!loading && !error && !needsNickname && dms.length > 0 && (
          <div>
            {dms.map((dm) => (
              <Link
                key={dm.topicId}
                href={`/dm/${dm.topicId}`}
                data-testid="dm-row"
                style={{ ...rowStyle, textDecoration: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-secondary)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <Avatar src={dm.peer.profileImage} name={dm.peer.nickname} size={36} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    data-testid="dm-row-title"
                    style={{
                      display: 'block',
                      fontSize: 'var(--text-body-sm)',
                      fontWeight: 600,
                      color: 'var(--color-text-primary)',
                      // Layout-only truncation: a very long nickname must not
                      // push the timestamp out of the row. The value is intact
                      // in the DOM.
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {dm.peer.nickname}
                  </span>
                  {/* SI-1 — never a preview. "Encrypted message" where the
                      channel has seen activity, "No messages yet" where it
                      provably has not; same two sentences the rail uses. */}
                  <span
                    data-testid="dm-row-preview"
                    style={{
                      display: 'block',
                      fontSize: 'var(--text-caption)',
                      color: 'var(--color-text-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {dm.lastActivityAt ? `🔒 ${t('chat.encryptedPreview')}` : t('chat.noMessagesYet')}
                  </span>
                </span>
                {dm.lastActivityAt && (
                  <span style={{
                    fontSize: 'var(--text-label)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-tertiary)',
                    flexShrink: 0,
                    alignSelf: 'flex-start',
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
