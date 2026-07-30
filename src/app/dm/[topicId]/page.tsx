'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import BareChatShell from '@/components/BareChatShell';
import ChatPanel from '@/components/ChatPanel';
import Avatar from '@/components/Avatar';
import Spinner from '@/components/Spinner';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import type { DmChannel } from '@/lib/dm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

/**
 * A single DM conversation, as a standalone full page -- the "open in new
 * tab" target for a DM room selected in `ChatRail.tsx` (`newTabHref` in
 * `src/lib/chatRail.ts`). Mirrors `src/app/chat/[topicId]/page.tsx` (same
 * bare shell, same "no CommunityLayout" rule -- see `BareChatShell.tsx` for
 * why) but resolves a DM channel instead of a topic.
 *
 * A DM is a hidden 2-member topic (`topics.kind='dm'`), so the conversation is
 * the EXISTING end-to-end-encrypted chat — this page mounts the same
 * `ChatPanel` every topic uses. There is deliberately no second chat
 * implementation and no second crypto path here: MLS genesis / External-Commit
 * join, sealing, and the TAK archive all happen inside `ChatPanel` →
 * `src/lib/mls/*`, entirely in the browser. The server is a blind relay (SI-1).
 *
 * Membership is resolved from `GET /api/dm`, which returns ONLY channels the
 * caller is a member of. A topicId that is missing from that list is therefore
 * either not a DM or not yours, and the panel is never mounted for it. That is a
 * UX guard, not the security boundary — `GET`/`POST /api/topics/{id}/chat` and
 * the `mls/*` routes each enforce membership server-side and answer 403.
 */

export default function DmConversationPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const topicId = params.topicId as string;

  const [channel, setChannel] = useState<DmChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsNickname, setNeedsNickname] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/dm');
        if (!alive) return;
        if (res.status === 401) { router.replace('/'); return; }
        if (res.status === 403) { setNeedsNickname(true); return; }
        if (!res.ok) throw new Error(t('dmConversationPage.loadError'));
        const data = await res.json();
        if (!alive) return;
        const found = (data.dms ?? []).find((d: DmChannel) => d.topicId === topicId) ?? null;
        setChannel(found);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('dmConversationPage.loadError'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, router]);

  /**
   * Recovery link for the error/not-found states — named after its
   * DESTINATION, not "Back". This is a popped-out tab with no meaningful
   * browser history, so a "Back" label promises navigation it cannot perform.
   * Closing lives in `BareChatShell`'s chrome; this is the separate case of
   * "the conversation did not load, here is somewhere real to go".
   * Mirrors `recoveryLink` in `src/app/chat/[topicId]/page.tsx`.
   */
  function recoveryLink(label = t('dmConversationPage.openMessages')) {
    return (
      <Link href="/dm" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
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
            {t('dmPage.needsNickname')}
          </p>
          <Link href={`/profile?returnTo=%2Fdm%2F${encodeURIComponent(topicId)}`} style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {t('dmPage.goToProfile')}
          </Link>
        </div>
      </BareChatShell>
    );
  }

  if (error) {
    return (
      <BareChatShell>
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-3)' }}>
            {error}
          </p>
          {recoveryLink()}
        </div>
      </BareChatShell>
    );
  }

  // Not in the caller's DM list → not a DM they belong to. Say so plainly
  // rather than mounting a panel that would only 403 on every request.
  if (!channel) {
    return (
      <BareChatShell>
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: 'var(--foreground)', margin: '0 0 var(--space-2)' }}>
            {t('dmConversationPage.notFound.title')}
          </p>
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: '0 0 var(--space-3)', lineHeight: 1.6 }}>
            {t('dmConversationPage.notFound.body')}
          </p>
          {recoveryLink()}
        </div>
      </BareChatShell>
    );
  }

  return (
    <BareChatShell>
      {/* Peer header — the DM topic's own title is the placeholder 'dm', so
          the counterpart's identity is what the conversation is named after
          (same as the mobile ChatRoom, which passes peer.nickname as title). */}
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
        <Avatar src={channel.peer.profileImage} name={channel.peer.nickname} size={36} />
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
            {channel.peer.nickname}
          </div>
          <div className="os-label" style={{ color: 'var(--muted)', marginTop: 1 }}>
            {t('dmConversationPage.encryptedLabel')}
          </div>
        </div>
        {/* The panel below hides its own header, so the per-topic mute (P-S)
            is hosted here — exactly what the mobile chat sheet does. */}
        <TopicMuteToggle topicId={topicId} enabled style={{ lineHeight: 1, flexShrink: 0 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel
          topicId={topicId}
          isGuest={false}
          isMember
          fullHeight
          framed
          hideHeader
        />
      </div>
    </BareChatShell>
  );
}
