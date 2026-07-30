'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import SNSContent from '@/components/SNSContent';
import Avatar from '@/components/Avatar';
import UserCard from '@/components/UserCard';
import { relativeTime } from '@/lib/utils';
import { PinIcon, RecordIcon } from '@/components/icons';
import Badge from '@/components/Badge';
import PollRenderer from '@/components/PollRenderer';
import PostActionBar from '@/components/post/PostActionBar';
import ReactionRow from '@/components/post/ReactionRow';
import MediaGallery from '@/components/post/MediaGallery';
import { collectPostMedia, stripVideoUrls } from '@/lib/postMedia';
import type { ReactionSummary } from '@/hooks/usePostMutations';
import type { Poll } from '@/lib/polls';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PostCardPost {
  id: string;
  title: string;
  content: string;
  /** Phase A2 unified media (images + video URLs). Optional so legacy posts
   *  without an attached media payload still render via content extraction. */
  media?: { images?: string[]; videos?: string[] } | null;
  upvoteCount?: number;
  commentCount?: number;
  viewCount?: number;
  createdAt: string;
  isPinned?: boolean;
  userVoted?: number | null;
  userBookmarked?: boolean;
  userRecorded?: boolean;
  reactions?: ReactionSummary[];
  authorNickname?: string;
  authorProfileImage?: string | null;
  authorId?: string;
  recordCount?: number;
  /** Topic breadcrumb — shown when rendering in a cross-topic feed */
  topicTitle?: string;
  topicId?: string;
  badges?: Array<{ type: string; label: string; country?: string; domain?: string }>;
  isAI?: boolean;
  /** Phase B poll block (optional). Hydrated by `attachPollsToPosts`. */
  poll?: Poll | null;
  /** Tag chip row — appears between media/poll and the action bar. */
  tags?: Array<{ name: string; slug: string }>;
  /** Whether the signed-in viewer is a member of this post's topic. Used
   *  to render the green "Joined" pill next to the topic chip — mirrors
   *  the PostDetail header. The API surfaces this in both the cross-topic
   *  feed (`/api/feed`) and the per-topic listing (`/api/topics/:id/posts`). */
  isJoinedTopic?: boolean;
}

export interface PostCardProps {
  post: PostCardPost;
  href: string;

  // Author header
  showAuthor?: boolean;

  // Show topic breadcrumb (for cross-topic feeds)
  showTopic?: boolean;

  // Pin
  isPinned?: boolean;

  // Reactions & actions
  userVoted?: number | null;
  reactions?: ReactionSummary[];
  sessionUserId?: string | null;
  authorId?: string;
  topicCreatorId?: string | null;

  // Callbacks
  onDelete?: (postId: string) => void;
  onPin?: (postId: string) => void;
  onRecord?: (postId: string) => void;

  // Expandable content
  expandable?: boolean;
}

// ─── Tag chip row ────────────────────────────────────────────────────────────
function TagChipRow({ tags }: { tags: Array<{ name: string; slug: string }> }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}
      onClick={(e) => e.stopPropagation()}
    >
      {tags.map((t) => (
        <span
          key={t.slug}
          style={{
            background: 'rgba(59,130,246,0.08)',
            color: 'var(--accent)',
            border: '1px solid rgba(59,130,246,0.15)',
            borderRadius: 4,
            padding: '1px 7px',
            fontSize: 11,
            fontFamily: 'monospace',
            lineHeight: 1.6,
          }}
        >
          #{t.name}
        </span>
      ))}
    </div>
  );
}

// ─── Post Card ───────────────────────────────────────────────────────────────

export default function PostCard({
  post,
  href,
  showAuthor = false,
  showTopic = false,
  isPinned,
  userVoted,
  reactions: reactionsProp,
  sessionUserId,
  authorId,
  topicCreatorId,
  onDelete,
  onPin,
  onRecord: _onRecord,
  expandable = true,
}: PostCardProps) {
  const [expanded, setExpanded] = useState(false);
  // I04: overflow detection — true when body content exceeds 200px height.
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Poll state — local cache so vote/unvote feels instant.
  const [poll, setPoll] = useState<Poll | null>(post.poll ?? null);
  const [pollLoading, setPollLoading] = useState(false);
  useEffect(() => {
    setPoll(post.poll ?? null);
  }, [post.poll]);

  // I04: detect overflow on the body wrapper using ResizeObserver.
  // Runs only when not yet expanded; the cached value persists while
  // expanded so the Show less button stays visible.
  useEffect(() => {
    if (expanded || !expandable) return;
    const el = bodyRef.current;
    if (!el) return;

    const check = () => setBodyOverflows(el.scrollHeight > 202);

    check();

    // Re-check after images load
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    imgs.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', check, { once: true });
        img.addEventListener('error', check, { once: true });
      }
    });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(check);
      ro.observe(el);
    }

    return () => {
      imgs.forEach((img) => {
        img.removeEventListener('load', check);
        img.removeEventListener('error', check);
      });
      ro?.disconnect();
    };
  }, [expanded, expandable, post.content]);

  const submitPollVote = useCallback(
    async (optionIds: string[]) => {
      setPollLoading(true);
      try {
        const res = await fetch(`/api/posts/${post.id}/poll/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionIds }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? 'Vote failed');
        }
        const data = await res.json();
        if (data.poll) setPoll(data.poll);
      } finally {
        setPollLoading(false);
      }
    },
    [post.id],
  );

  const clearPollVote = useCallback(async () => {
    setPollLoading(true);
    try {
      const res = await fetch(`/api/posts/${post.id}/poll/vote`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Unvote failed');
      }
      const data = await res.json();
      if (data.poll) setPoll(data.poll);
    } finally {
      setPollLoading(false);
    }
  }, [post.id]);

  const handlePin = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await fetch(`/api/posts/${post.id}/pin`, { method: 'POST' });
      onPin?.(post.id);
    } catch {}
  };

  const resolvedIsPinned = isPinned ?? post.isPinned;
  const resolvedUserVoted = userVoted ?? post.userVoted ?? null;
  const resolvedAuthorId = authorId ?? post.authorId;
  const resolvedReactions = reactionsProp ?? post.reactions;
  const isTopicCreator = sessionUserId && topicCreatorId && sessionUserId === topicCreatorId;
  // Guest is anyone without a session id. Hides interactive affordances.
  const isGuest = !sessionUserId;

  // Topic breadcrumb (reused in both modes)
  // When the viewer is a member, append a small green "Joined" pill so the
  // feed mirrors the PostDetail header. We only render the pill in the
  // cross-topic feed (showTopic=true), where the topic chip itself is
  // visible. The per-topic feed renders the pill separately below the
  // title since there's no breadcrumb row to attach to.
  const joinedPill = post.isJoinedTopic ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9,
        fontWeight: 700,
        color: '#22c55e',
        background: 'rgba(34,197,94,0.10)',
        border: '1px solid rgba(34,197,94,0.25)',
        borderRadius: 4,
        padding: '1px 6px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.2,
        verticalAlign: 'middle',
      }}
      aria-label="You are a member of this topic"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      Joined
    </span>
  ) : null;

  // Inline pin icon — `em`-relative sizing + vertical-align baseline so the
  // pin's optical center matches the title text's x-height (flex+center
  // shifted the icon up because of h3 line-height extra space).
  const pinnedTitleIcon = resolvedIsPinned ? (
    <svg
      width="0.85em"
      height="0.85em"
      viewBox="0 0 24 24"
      fill="var(--accent)"
      style={{
        display: 'inline-block',
        verticalAlign: '-0.12em',
        marginRight: '0.32em',
      }}
      aria-label="Pinned post"
    >
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z" />
    </svg>
  ) : null;

  const topicBreadcrumb =
    showTopic && post.topicTitle && post.topicId ? (
      <div
        style={{
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <Link
          href={`/topics/${post.topicId}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            color: 'var(--accent)',
            textDecoration: 'none',
            letterSpacing: '0.02em',
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '0.8';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '1';
          }}
        >
          t/{post.topicTitle}
        </Link>
        {joinedPill}
      </div>
    ) : null;

  return (
    <article
      style={{
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'transparent',
        transition: 'background 0.12s',
        cursor: 'pointer',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {/* Admin Pin toggle removed from card — visually duplicated the
          title-row pinnedTitleIcon. Topic admins can still pin/unpin from
          the post detail kebab menu. */}

      {topicBreadcrumb}

      {/* I06: per-topic feed (showTopic=false) — render topic chip + Joined
          pill above the card body, outside the nav Link to avoid nested
          anchors. Pin status is conveyed by the title-row icon, not here. */}
      {!showTopic && post.isJoinedTopic && post.topicTitle && post.topicId && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}
          onClick={(e) => e.stopPropagation()}
        >
          <Link
            href={`/topics/${post.topicId}`}
            style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              color: 'var(--accent)',
              textDecoration: 'none',
              letterSpacing: '0.02em',
            }}
          >
            t/{post.topicTitle}
          </Link>
          {joinedPill}
        </div>
      )}

      {/* Card body — clicking navigates; action bar stops propagation */}
      <Link
        href={href}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        {showAuthor && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            {resolvedAuthorId ? (
              <UserCard
                userId={resolvedAuthorId}
                nickname={post.authorNickname ?? ''}
                profileImage={post.authorProfileImage}
                badges={post.badges}
              >
                <Avatar
                  src={post.authorProfileImage}
                  name={post.authorNickname ?? ''}
                  size={24}
                  style={{ marginTop: 1 }}
                />
              </UserCard>
            ) : (
              <Avatar
                src={post.authorProfileImage}
                name={post.authorNickname ?? ''}
                size={24}
                style={{ marginTop: 1 }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500, color: '#9ca3af' }}>{post.authorNickname}</span>
                {post.isAI && <Badge type="ai" />}
                {post.badges &&
                  post.badges.length > 0 &&
                  post.badges.map((b, i) => (
                    <Badge key={i} type={b.type} label={b.label} country={b.country} domain={b.domain} />
                  ))}
                <span style={{ color: '#4b5563' }}>·</span>
                <span style={{ color: '#6b7280', fontFamily: 'var(--font-mono)' }}>
                  {relativeTime(post.createdAt)}
                </span>
              </div>
            </div>
          </div>
        )}

        <h3
          style={{
            fontSize: 18,
            fontWeight: 700,
            margin: '0 0 8px 0',
            letterSpacing: '-0.015em',
            color: '#f3f4f6',
            lineHeight: 1.3,
          }}
        >
          {pinnedTitleIcon}
          {post.title}
        </h3>

        {/* I04: body wrapper with max-height cap when not expanded. */}
        <div
          ref={bodyRef}
          style={
            expandable && !expanded
              ? { maxHeight: 200, overflow: 'hidden', position: 'relative' }
              : undefined
          }
        >
          {/* Fade gradient when content is clipped. */}
          {expandable && !expanded && bodyOverflows && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 56,
                background: 'linear-gradient(transparent, #0a0a0a)',
                pointerEvents: 'none',
              }}
            />
          )}
          {/* TODO: SNSContent owns its own truncation path (truncate prop +
              onToggleExpand). With I04 we cap height at the PostCard level
              instead. Passing truncate=false always here to avoid double
              capping; SNSContent still handles link-preview / OG card in
              non-truncate mode. When SNSContent exposes a prop to disable
              its internal fade/button without disabling link-preview, use it. */}
          <SNSContent
            html={stripVideoUrls(post.content)}
            truncate={false}
            stripInlineImages
          />
        </div>

        {/* I04: Show more / Show less toggle — visible whenever the body
            originally overflowed the clip. Mirrors mobile PostCard which
            toggles both ways. */}
        {expandable && bodyOverflows && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((v) => !v); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              padding: '2px 0',
              marginTop: 6,
              letterSpacing: '-0.01em',
              display: 'block',
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}

        {/* I04: always show media (text expansion doesn't hide media). */}
        {(() => {
          const { images, videos } = collectPostMedia(post);
          return <MediaGallery images={images} videos={videos} mode="feed" />;
        })()}
      </Link>

      {/* Poll — outside the Link so vote buttons don't trigger navigation. */}
      {poll && (
        <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <PollRenderer
            poll={poll}
            onVote={submitPollVote}
            onUnvote={clearPollVote}
            loading={pollLoading}
          />
        </div>
      )}

      <TagChipRow tags={post.tags ?? []} />

      {/* Recorded on Base badge */}
      {(post.recordCount ?? 0) > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
            padding: '4px 10px',
            background: 'rgba(139,92,246,0.08)',
            border: '1px solid rgba(139,92,246,0.15)',
            borderRadius: 6,
            fontSize: 12,
            color: '#a78bfa',
            width: 'fit-content',
          }}
        >
          <RecordIcon size={12} />
          <span>Recorded on Base</span>
          <span style={{ color: '#6b7280' }}>|</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {post.recordCount} record{(post.recordCount ?? 0) !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Reaction stats (read-only on list rows) */}
      <div style={{ marginTop: 8 }}>
        <ReactionRow
          postId={post.id}
          reactions={resolvedReactions}
          interactive={false}
          disabled={isGuest}
          initialKnown={resolvedReactions !== undefined}
        />
      </div>

      {/* Shared action bar — vote / comment / view / share / record /
          bookmark / delete. Same component used by the detail page. */}
      <PostActionBar
        postId={post.id}
        href={href}
        upvoteCount={post.upvoteCount ?? 0}
        userVoted={resolvedUserVoted}
        commentCount={post.commentCount ?? 0}
        viewCount={post.viewCount ?? 0}
        recordCount={post.recordCount ?? 0}
        userRecorded={post.userRecorded}
        bookmarked={post.userBookmarked}
        authorId={resolvedAuthorId}
        sessionUserId={sessionUserId}
        isGuest={isGuest}
        variant="list"
        onDelete={onDelete}
      />
    </article>
  );
}
