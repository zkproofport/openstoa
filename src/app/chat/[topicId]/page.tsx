'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import BareChatShell from '@/components/BareChatShell';
import ChatPanel from '@/components/ChatPanel';
import Spinner from '@/components/Spinner';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import TopicMembersList, { type TopicMember } from '@/components/TopicMembersList';
import { useTranslation } from '@/lib/i18n/I18nProvider';

const MembersIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

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
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  // Members overlay (FIX3): the header's "· N members" count was previously
  // dead text. Toggling it renders the SAME member-list treatment the chat
  // rail uses (`TopicMembersList.tsx`, shared rather than a second bespoke
  // list) as an overlay ABOVE `ChatPanel`, not in place of it — replacing
  // the panel would drop the SSE stream and re-run the initial history
  // fetch on every peek at the members.
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<TopicMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);

  /*
   * One query for the whole page, shared with the header and the chat panel.
   * The local mirror stays because the rest of this file reads it as state.
   */
  const { session } = useSession();
  useEffect(() => {
    setViewerUserId(session?.userId ?? null);
  }, [session]);

  const loadMembers = useCallback(() => {
    setMembers(null);
    setMembersFailed(false);
    apiFetch(`/api/topics/${topicId}/members`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed to load members'))))
      .then((d) => setMembers(Array.isArray(d?.members) ? d.members : []))
      .catch(() => setMembersFailed(true));
  }, [topicId]);

  const toggleMembers = useCallback(() => {
    setShowMembers((v) => {
      const next = !v;
      if (next) loadMembers();
      return next;
    });
  }, [loadMembers]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/topics/${topicId}`, { credentials: 'include' });
        if (!alive) return;
        if (res.status === 401) { router.replace('/'); return; }
        if (res.status === 403) {
          // Safety net only: the nickname gate that used to answer 403 here
          // is gone, but a future rule might, and a dead error string is worse
          // than an offered remedy.
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
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-3)' }}>
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
            {topic.memberCount != null && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={toggleMembers}
                  aria-pressed={showMembers}
                  aria-label={showMembers ? t('chatRail.hideMembers') : t('chatRail.showMembers')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    color: showMembers ? 'var(--accent)' : 'inherit',
                    font: 'inherit',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                  }}
                >
                  {MembersIcon}
                  {topic.memberCount} {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
                </button>
              </>
            )}
          </div>
        </div>
        <TopicMuteToggle topicId={topicId} enabled={topic.isMember === true} style={{ lineHeight: 1, flexShrink: 0 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <ChatPanel
          topicId={topicId}
          isGuest={false}
          isMember={topic.isMember === true}
          fullHeight
          framed
          hideHeader
        />
        {showMembers && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--background)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 2,
            }}
          >
            <TopicMembersList members={members} failed={membersFailed} onRetry={loadMembers} viewerUserId={viewerUserId} />
          </div>
        )}
      </div>
    </BareChatShell>
  );
}
