'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import SNSContent from '@/components/SNSContent';
import Avatar from '@/components/Avatar';
import { relativeTime } from '@/lib/utils';
import { PinIcon, RecordIcon } from '@/components/icons';
import Badge from '@/components/Badge';
import PollRenderer from '@/components/PollRenderer';
import PostActionBar from '@/components/post/PostActionBar';
import ReactionRow from '@/components/post/ReactionRow';
import MediaGallery from '@/components/post/MediaGallery';
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

// ─── Media collection ────────────────────────────────────────────────────────

// Collect images + video URLs from explicit `post.media` AND legacy HTML
// in `post.content`. Returns plain URL arrays so the shared MediaGallery
// can render the same swipeable carousel the mobile uses.
function collectMedia(post: PostCardPost): { images: string[]; videos: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  const seen = new Set<string>();
  const pushImg = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    images.push(url);
  };
  const pushVid = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    videos.push(url);
  };

  for (const url of post.media?.images ?? []) pushImg(url);
  for (const url of post.media?.videos ?? []) pushVid(url);

  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(post.content)) !== null) pushImg(m[1]);

  const ytRegex = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}\S*/gi;
  while ((m = ytRegex.exec(post.content)) !== null) pushVid(m[0]);

  const vimeoRegex = /https?:\/\/(?:www\.)?vimeo\.com\/\d+\S*/gi;
  while ((m = vimeoRegex.exec(post.content)) !== null) pushVid(m[0]);

  return { images, videos };
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

  // Poll state — local cache so vote/unvote feels instant.
  const [poll, setPoll] = useState<Poll | null>(post.poll ?? null);
  const [pollLoading, setPollLoading] = useState(false);
  useEffect(() => {
    setPoll(post.poll ?? null);
  }, [post.poll]);

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

  const handleToggleExpand = useCallback(() => {
    setExpanded(true);
  }, []);

  const resolvedIsPinned = isPinned ?? post.isPinned;
  const resolvedUserVoted = userVoted ?? post.userVoted ?? null;
  const resolvedAuthorId = authorId ?? post.authorId;
  const resolvedReactions = reactionsProp ?? post.reactions;
  const isTopicCreator = sessionUserId && topicCreatorId && sessionUserId === topicCreatorId;
  // Guest is anyone without a session id. Hides interactive affordances.
  const isGuest = !sessionUserId;

  // Topic breadcrumb (reused in both modes)
  const topicBreadcrumb =
    showTopic && post.topicTitle && post.topicId ? (
      <div style={{ marginBottom: 6 }}>
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
      </div>
    ) : null;

  return (
    <article
      style={{
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
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
      {/* Pin button for topic creator — top right */}
      {isTopicCreator && (
        <button
          onClick={handlePin}
          title={resolvedIsPinned ? 'Unpin' : 'Pin post'}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: resolvedIsPinned ? 'var(--accent)' : '#4b5563',
            cursor: 'pointer',
            padding: 4,
            borderRadius: 4,
            transition: 'color 0.12s',
            zIndex: 2,
          }}
        >
          <PinIcon filled={resolvedIsPinned} />
        </button>
      )}

      {topicBreadcrumb}

      {/* Card body — clicking navigates; action bar stops propagation */}
      <Link
        href={href}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        {showAuthor && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            <Avatar
              src={post.authorProfileImage}
              name={post.authorNickname ?? ''}
              size={24}
              style={{ marginTop: 1 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: '#e5e7eb' }}>{post.authorNickname}</span>
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
            fontSize: 15,
            fontWeight: 700,
            margin: '0 0 6px 0',
            letterSpacing: '-0.01em',
            color: '#e5e7eb',
            lineHeight: 1.4,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {resolvedIsPinned && (
            <span style={{ fontSize: 12, flexShrink: 0 }} title="Pinned post">
              📌
            </span>
          )}
          {post.title}
        </h3>

        <div>
          {/* Media is rendered by MediaGallery below — keep SNSContent
              focused on the text body so we don't double-up images. */}
          <SNSContent
            html={post.content}
            truncate={expandable ? !expanded : true}
            maxLines={3}
            onToggleExpand={expandable ? handleToggleExpand : undefined}
          />
        </div>

        {!expanded && (() => {
          const { images, videos } = collectMedia(post);
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
