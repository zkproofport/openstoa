'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import ChatPanel from '@/components/ChatPanel';
import Avatar from '@/components/Avatar';
import Spinner from '@/components/Spinner';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import type { DmChannel } from '@/lib/dm';

/**
 * A single DM conversation.
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

// The centre column of CommunityLayout pads 20px top / 80px below a 49px
// sticky header; subtracting them lets the panel own the remaining viewport so
// its message list is the only scroller and the composer stays pinned.
const CHAT_HEIGHT = 'calc(100vh - 149px)';

export default function DmConversationPage() {
  const params = useParams();
  const router = useRouter();
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
        if (!res.ok) throw new Error('Failed to load this conversation');
        const data = await res.json();
        if (!alive) return;
        const found = (data.dms ?? []).find((d: DmChannel) => d.topicId === topicId) ?? null;
        setChannel(found);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load this conversation');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [topicId, router]);

  function backLink(label = 'Back to messages') {
    return (
      <Link href="/dm" style={{ color: 'var(--accent)', fontSize: 14 }}>
        {label}
      </Link>
    );
  }

  // NOTE: `topicId` is deliberately NOT passed to CommunityLayout. That prop
  // makes the layout mount its own ChatPanel in the right sidebar (and the
  // mobile sheet), which would give the page TWO live panels for the same
  // topic — two SSE streams racing to MLS-open each message, where the loser
  // renders '[unable to decrypt]' because MLS drops the per-message key after
  // the first decrypt (see src/__tests__/mls-session-single-consumer.test.ts).
  if (loading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (needsNickname) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 12px' }}>
            Set a nickname before you can send direct messages.
          </p>
          <Link href={`/profile?returnTo=%2Fdm%2F${encodeURIComponent(topicId)}`} style={{ color: 'var(--accent)', fontSize: 14 }}>
            Go to profile
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  if (error) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 14, margin: '0 0 12px' }}>
            {error}
          </p>
          {backLink()}
        </div>
      </CommunityLayout>
    );
  }

  // Not in the caller's DM list → not a DM they belong to. Say so plainly
  // rather than mounting a panel that would only 403 on every request.
  if (!channel) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)', margin: '0 0 8px' }}>
            Conversation not found
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.6 }}>
            This conversation doesn&rsquo;t exist, or you&rsquo;re not part of it.
          </p>
          {backLink()}
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '0 1.5rem',
        height: CHAT_HEIGHT,
        minHeight: 420,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Peer header — the DM topic's own title is the placeholder 'dm', so
            the counterpart's identity is what the conversation is named after
            (same as the mobile ChatRoom, which passes peer.nickname as title). */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 4px',
          flexShrink: 0,
        }}>
          <Link
            href="/dm"
            aria-label="Back to messages"
            style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <Avatar src={channel.peer.profileImage} name={channel.peer.nickname} size={36} />
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
              {channel.peer.nickname}
            </div>
            <div style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--muted)',
              marginTop: 1,
            }}>
              Direct message &middot; end-to-end encrypted
            </div>
          </div>
          {/* The panel below hides its own header, so the per-topic mute (P-S)
              is hosted here — exactly what the mobile chat sheet does. */}
          <TopicMuteToggle topicId={topicId} enabled style={{ lineHeight: 1, flexShrink: 0 }} />
        </div>

        <div style={{ flex: 1, minHeight: 0, paddingBottom: 16 }}>
          <ChatPanel
            topicId={topicId}
            isGuest={false}
            isMember
            fullHeight
            framed
            hideHeader
          />
        </div>
      </div>
    </CommunityLayout>
  );
}
