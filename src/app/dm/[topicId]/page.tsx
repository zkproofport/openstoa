'use client';

import { apiFetch } from '@/lib/apiFetch';
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
        const res = await apiFetch('/api/dm');
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
    // `.os-button` rather than a bare inline link: in every one of these states
    // it is the ONLY thing on screen to act on, and a text link is a ~20px
    // target under the 44px minimum this app holds everywhere else.
    return (
      <Link href="/dm" className="os-button">
        {label}
      </Link>
    );
  }

  /** One centred column for every non-conversation state, so loading, the
   *  nickname prompt, the failure and the not-found all sit in the same place
   *  rather than each at its own arbitrary inset. */
  function stateBlock(children: React.ReactNode, role?: 'alert') {
    return (
      <BareChatShell>
        <div
          role={role}
          style={{
            padding: 'var(--space-7) var(--space-5)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-3)',
          }}
        >
          {children}
        </div>
      </BareChatShell>
    );
  }

  if (loading) {
    return stateBlock(<Spinner />);
  }

  if (needsNickname) {
    return stateBlock(
      <>
        <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-text-secondary)', margin: 0 }}>
          {t('dmPage.needsNickname')}
        </p>
        <Link href={`/profile?returnTo=%2Fdm%2F${encodeURIComponent(topicId)}`} className="os-button">
          {t('dmPage.goToProfile')}
        </Link>
      </>,
    );
  }

  if (error) {
    return stateBlock(
      <>
        <p style={{
          color: 'var(--color-status-danger)',
          fontSize: 'var(--text-body-lg)',
          fontWeight: 600,
          margin: 0,
        }}>
          {error}
        </p>
        {recoveryLink()}
      </>,
      'alert',
    );
  }

  // Not in the caller's DM list → not a DM they belong to. Say so plainly
  // rather than mounting a panel that would only 403 on every request. This is
  // deliberately NOT the error treatment: nothing failed.
  if (!channel) {
    return stateBlock(
      <>
        <p style={{
          fontSize: 'var(--text-body-lg)',
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          letterSpacing: '-0.02em',
          margin: 0,
        }}>
          {t('dmConversationPage.notFound.title')}
        </p>
        <p style={{
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-secondary)',
          margin: 0,
          lineHeight: 'var(--leading-base)',
          maxWidth: '40ch',
        }}>
          {t('dmConversationPage.notFound.body')}
        </p>
        {recoveryLink()}
      </>,
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
            fontSize: 'var(--text-body-lg)',
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            letterSpacing: '-0.01em',
            lineHeight: 'var(--leading-tight)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {channel.peer.nickname}
          </div>
          {/* Says WHAT this conversation is, not that it is encrypted — the
              E2EE strip `ChatPanel` renders directly below already says that,
              in full, and saying it twice one line apart makes both read as
              decoration rather than as a claim. */}
          <div className="os-label" style={{ color: 'var(--color-text-secondary)', marginTop: 1 }}>
            {t('dmConversationPage.subtitle')}
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
