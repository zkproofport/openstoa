'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import BareChatShell from '@/components/BareChatShell';
import ChatPanel from '@/components/ChatPanel';
import Spinner from '@/components/Spinner';
import TopicMuteToggle from '@/components/TopicMuteToggle';

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
        if (!res.ok) throw new Error('Topic not found');
        const data = await res.json();
        if (!alive) return;
        const t = data?.topic ?? data;
        setTopic({
          id: t.id,
          title: t.title,
          description: t.description ?? null,
          memberCount: t.memberCount,
          isMember: t.isMember ?? data.isMember,
        });
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load this topic');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [topicId, router]);

  function backLink(label = 'Back to topic') {
    return (
      <Link href={`/topics/${topicId}`} style={{ color: 'var(--accent)', fontSize: 14 }}>
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
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 12px' }}>
            Set a nickname before you can use chat.
          </p>
          <Link href={`/profile?returnTo=%2Fchat%2F${encodeURIComponent(topicId)}`} style={{ color: 'var(--accent)', fontSize: 14 }}>
            Go to profile
          </Link>
        </div>
      </BareChatShell>
    );
  }

  if (error || !topic) {
    return (
      <BareChatShell>
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 14, margin: '0 0 12px' }}>
            {error ?? 'Topic not found'}
          </p>
          {backLink()}
        </div>
      </BareChatShell>
    );
  }

  return (
    <BareChatShell>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <Link
          href={`/topics/${topicId}`}
          aria-label="Back to topic"
          style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {topic.title}
          </div>
          <div style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--muted)',
            marginTop: 1,
          }}>
            Live chat{topic.memberCount != null ? ` · ${topic.memberCount} member${topic.memberCount !== 1 ? 's' : ''}` : ''}
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
