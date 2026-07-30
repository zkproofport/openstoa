'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import BareChatShell from '@/components/BareChatShell';
import ChatPanel from '@/components/ChatPanel';
import Spinner from '@/components/Spinner';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/**
 * Standalone full-page topic chat -- the "open in new tab" target for a topic
 * room selected in `ChatRail.tsx` (`newTabHref` in `src/lib/chatRail.ts`).
 * Mirrors `src/app/dm/[topicId]/page.tsx` (same bare shell, same "no
 * CommunityLayout" rule -- see `BareChatShell.tsx` for why) but resolves a
 * TOPIC instead of a DM channel: `GET /api/topics/{topicId}` for
 * title/description/membership.
 */

interface TopicSummary {
  id: string;
  title: string;
  description?: string | null;
  memberCount?: number;
  isMember?: boolean;
}

export default function TopicChatPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const topicId = params.topicId as string;

  const [topic, setTopic] = useState<TopicSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsNickname, setNeedsNickname] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/topics/${topicId}`, { credentials: 'include' });
        if (!alive) return;
        if (res.status === 401) { router.replace('/'); return; }
        if (res.status === 403) {
          // /api/topics/{id} 403s a signed-in caller with an `anon_` nickname
          // the same way /api/dm does — same remedy, same redirect target.
          setNeedsNickname(true);
          return;
        }
        if (!res.ok) throw new Error(t('chatPage.notFound'));
        const data = await res.json();
        if (!alive) return;
        const topicData = data?.topic ?? data;
        setTopic({
          id: topicData.id,
          title: topicData.title,
          description: topicData.description ?? null,
          memberCount: topicData.memberCount,
          isMember: topicData.isMember ?? data.isMember,
        });
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('chatPage.loadError'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, router]);

  /**
   * Recovery link for the error/not-found states.
   *
   * Named after its DESTINATION, not "Back". This page is a popped-out tab
   * (opened via the rail's open-in-new-tab action, or straight from a pasted
   * URL), so it has no meaningful browser history to go back to — a "Back"
   * label here promises navigation the tab cannot perform. Closing lives in
   * `BareChatShell`'s own chrome; this is the separate case of "the room did
   * not load, here is somewhere real to go instead".
   */
  function recoveryLink(label = t('chatPage.openTopicPage')) {
    return (
      <Link href={`/topics/${topicId}`} style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
        {label}
      </Link>
    );
  }

  if (loading) {
    return (
      <BareChatShell>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 20px' }}>
          <Spinner />
        </div>
      </BareChatShell>
    );
  }

  if (needsNickname) {
    return (
      <BareChatShell>
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 var(--space-3)' }}>
            {t('chatPage.needsNickname')}
          </p>
          <Link href={`/profile?returnTo=%2Fchat%2F${encodeURIComponent(topicId)}`} style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {t('dmPage.goToProfile')}
          </Link>
        </div>
      </BareChatShell>
    );
  }

  if (error || !topic) {
    return (
      <BareChatShell>
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-3)' }}>
            {error ?? t('chatPage.notFound')}
          </p>
          {recoveryLink()}
        </div>
      </BareChatShell>
    );
  }

  return (
    <BareChatShell>
      {/* No back-arrow here on purpose — see BareChatShell's module doc (P-2).
          This is a popped-out tab; Close (in the shell's own chrome above)
          is the one exit affordance, not a "back" that has nowhere real to
          go. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 'var(--text-body)',
            fontWeight: 700,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {topic.title}
          </div>
          <div className="os-label" style={{ color: 'var(--muted)', marginTop: 1 }}>
            {t('chat.liveChat')}
            {topic.memberCount != null
              ? ` · ${topic.memberCount} ${topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}`
              : ''}
          </div>
        </div>
        <TopicMuteToggle topicId={topicId} enabled={topic.isMember === true} style={{ lineHeight: 1, flexShrink: 0 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel
          topicId={topicId}
          isGuest={false}
          isMember={topic.isMember === true}
          fullHeight
          framed
          hideHeader
        />
      </div>
    </BareChatShell>
  );
}
