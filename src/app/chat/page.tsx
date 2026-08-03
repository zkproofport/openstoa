'use client';

/**
 * Standalone unified chat list — the "open in new tab" target for the chat
 * rail's LIST header (`ChatRail.tsx`), the list-level counterpart of the
 * room-level `/chat/{id}` and `/dm/{id}` pages.
 *
 * Same bare shell as those two (`BareChatShell.tsx`, deliberately NOT
 * `CommunityLayout`) so a popped-out list and a popped-out room look like one
 * feature rather than two, and — the load-bearing reason — so this page never
 * renders a `ChatRail` of its own. `CommunityLayout` would, and a rail with a
 * room open is a second live `ChatPanel` for that room; MLS drops each
 * message's decrypt key on first use, so two panels on one topic permanently
 * break one of them. This page mounts NO `ChatPanel` at all.
 *
 * The tabs and rows come from `ChatRoomList.tsx`, shared verbatim with the
 * rail — the whole point of the extraction is that there is exactly one
 * implementation of "the conversation list" to keep correct.
 *
 * Opening a room navigates THIS tab to that room's own standalone page
 * (`/chat/{id}` / `/dm/{id}`) — the existing pop-out targets, not a third
 * navigation model. Browser Back then works, because unlike a freshly popped
 * room tab this one has somewhere to go back to.
 *
 * Not a pop-out-only shim: `/chat` is a real route that works from a typed or
 * bookmarked URL. Guests never reach it — `src/middleware.ts` has it in
 * neither the public nor the guest-accessible list, so an unauthenticated
 * request is redirected to `/?returnTo=/chat` before this component renders;
 * the session check below is the client-side backstop for an expired session.
 *
 * SI-1: like `/dm`, this page reads routing metadata only (`GET /api/topics`,
 * `GET /api/dm`). No message body, no preview, no crypto.
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BareChatShell from '@/components/BareChatShell';
import ChatRoomList, { type ListTab, type RailTopic, type RailDm } from '@/components/ChatRoomList';
import Spinner from '@/components/Spinner';
import { sortDmChannels } from '@/lib/dm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export default function ChatListPage() {
  const router = useRouter();
  const { t } = useTranslation();

  const [tab, setTab] = useState<ListTab>('topics');
  const [topics, setTopics] = useState<RailTopic[] | null>(null);
  const [dms, setDms] = useState<RailDm[] | null>(null);
  const [loading, setLoading] = useState(true);
  // A 401 hands off to `router.replace('/')`, which is not instant. Without
  // this the page would drop out of `loading` and paint its tab chrome over
  // two empty lists for the duration of the navigation — an empty shell that
  // reads as "you have no conversations" to a reader who is really just
  // signed out.
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A session with a temp `anon_` nickname is rejected by /api/dm with 403 —
  // same as /dm. Surface the real remedy instead of a dead error string.
  const [needsNickname, setNeedsNickname] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsNickname(false);
    setRedirecting(false);
    try {
      // Both lists are fetched up front, not per tab: the tabs are a view
      // switch over data the reader already asked for, and a fetch on every
      // tab click would make switching back and forth flash a spinner.
      const [topicsRes, dmsRes] = await Promise.all([fetch('/api/topics'), fetch('/api/dm')]);
      if (topicsRes.status === 401 || dmsRes.status === 401) {
        setRedirecting(true);
        router.replace('/');
        return;
      }
      if (topicsRes.status === 403 || dmsRes.status === 403) {
        setNeedsNickname(true);
        return;
      }
      if (!topicsRes.ok || !dmsRes.ok) throw new Error(t('chatListPage.loadError'));
      const [topicsData, dmsData] = await Promise.all([topicsRes.json(), dmsRes.json()]);
      setTopics(Array.isArray(topicsData?.topics) ? topicsData.topics : []);
      setDms(sortDmChannels(Array.isArray(dmsData?.dms) ? dmsData.dms : []));
    } catch (err) {
      // An empty list here would read as "you have no conversations", which is
      // both wrong and undebuggable — say it failed and offer a retry, the
      // same call /dm makes.
      setError(err instanceof Error ? err.message : t('chatListPage.loadError'));
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openTopic = useCallback((topic: RailTopic) => router.push(`/chat/${topic.id}`), [router]);
  const openDm = useCallback((dm: RailDm) => router.push(`/dm/${dm.topicId}`), [router]);

  return (
    <BareChatShell>
      {/* Identity row — the same shape the room pages use (title + os-label
          subtitle), so the popped-out list and a popped-out room share one
          silhouette. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 'var(--text-body)',
              fontWeight: 700,
              color: 'var(--foreground)',
              letterSpacing: '-0.01em',
            }}
          >
            {t('chat.title')}
          </div>
          <div className="os-label" style={{ color: 'var(--muted)', marginTop: 1 }}>
            {t('chatListPage.subtitle')}
          </div>
        </div>
      </div>

      {loading || redirecting ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 20px' }}>
          <Spinner />
        </div>
      ) : needsNickname ? (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 var(--space-3)' }}>
            {t('chatListPage.needsNickname')}
          </p>
          <Link href="/profile?returnTo=%2Fchat" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {t('dmPage.goToProfile')}
          </Link>
        </div>
      ) : error ? (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p
            style={{
              color: 'var(--color-status-danger)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-body-sm)',
              margin: '0 0 var(--space-3)',
            }}
          >
            {error}
          </p>
          <button
            type="button"
            onClick={() => load()}
            style={{
              background: 'var(--color-brand-primary-muted)',
              color: 'var(--accent)',
              border: '1px solid color-mix(in srgb, var(--color-brand-primary) 20%, transparent)',
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
      ) : (
        <ChatRoomList
          tab={tab}
          onTabChange={setTab}
          topics={topics}
          dms={dms}
          onOpenTopic={openTopic}
          onOpenDm={openDm}
        />
      )}
    </BareChatShell>
  );
}
