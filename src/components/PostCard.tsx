'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import SNSContent from '@/components/SNSContent';
import Avatar from '@/components/Avatar';
import { relativeTime } from '@/lib/utils';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, TrashIcon, PinIcon, RecordIcon } from '@/components/icons';
import Badge from '@/components/Badge';
import PollRenderer from '@/components/PollRenderer';
import type { Poll } from '@/lib/polls';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Reaction {
  emoji: string;
  count: number;
  userReacted: boolean;
}

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
  reactions?: Reaction[];
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

// ─── Tag chip row ────────────────────────────────────────────────────────────
function TagChipRow({ tags }: { tags: Array<{ name: string; slug: string }> }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 8,
      }}
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
  reactions?: Reaction[];
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

// ─── Media preview extraction ────────────────────────────────────────────────

type MediaPreviewItem = { type: 'image' | 'youtube' | 'vimeo'; src: string; thumbnail: string };

/**
 * Build the compact thumbnail strip from `post.media` first, falling back to
 * URLs/imgs still embedded inside legacy `post.content` HTML. Deduplicates by
 * src so the same image isn't shown twice when a legacy post has been migrated.
 */
function extractMediaPreview(post: PostCardPost): MediaPreviewItem[] {
  const out: MediaPreviewItem[] = [];
  const seen = new Set<string>();
  const push = (item: MediaPreviewItem) => {
    if (seen.has(item.src)) return;
    seen.add(item.src);
    out.push(item);
  };

  // 1) Explicit media from the unified composer.
  for (const url of post.media?.images ?? []) {
    push({ type: 'image', src: url, thumbnail: url });
  }
  for (const url of post.media?.videos ?? []) {
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (yt) {
      push({ type: 'youtube', src: yt[1], thumbnail: `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg` });
      continue;
    }
    const vimeo = url.match(/vimeo\.com\/(\d+)/);
    if (vimeo) push({ type: 'vimeo', src: vimeo[1], thumbnail: '' });
  }

  // 2) Legacy HTML extraction — images embedded as <img>, video URLs in text/href.
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let imgM;
  while ((imgM = imgRegex.exec(post.content)) !== null) {
    push({ type: 'image', src: imgM[1], thumbnail: imgM[1] });
  }

  const ytRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/g;
  let ytM;
  while ((ytM = ytRegex.exec(post.content)) !== null) {
    push({ type: 'youtube', src: ytM[1], thumbnail: `https://img.youtube.com/vi/${ytM[1]}/mqdefault.jpg` });
  }

  const vimeoRegex = /vimeo\.com\/(\d+)/g;
  let vimeoM;
  while ((vimeoM = vimeoRegex.exec(post.content)) !== null) {
    push({ type: 'vimeo', src: vimeoM[1], thumbnail: '' });
  }

  return out;
}

// ─── Action Button ───────────────────────────────────────────────────────────

function ActionButton({
  icon,
  count,
  color,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  count?: number;
  color?: string;
  label?: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const activeColor = color ?? 'var(--accent)';

  return (
    <button
      type="button"
      onClick={onClick ?? ((e) => { e.preventDefault(); e.stopPropagation(); })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? (active ? `${activeColor}15` : 'rgba(255,255,255,0.05)')
          : 'none',
        border: 'none',
        color: active ? activeColor : (hovered ? activeColor : '#6b7280'),
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '5px 10px',
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        transition: 'color 0.12s, background 0.12s',
        userSelect: 'none',
      }}
    >
      {icon}
      {(count !== undefined && count > 0) && <span>{count}</span>}
      {label && <span>{label}</span>}
    </button>
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
  onRecord,
  expandable = true,
}: PostCardProps) {
  // Determine if we have "rich" features (topic-page mode)
  const hasRichFeatures = showAuthor || reactionsProp !== undefined || onDelete || onPin;

  // State for rich features
  const [shareText, setShareText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentOverflows, setContentOverflows] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Reactions state
  const [reactions, setReactions] = useState<Reaction[]>(reactionsProp ?? post.reactions ?? []);
  const [reactionsLoaded, setReactionsLoaded] = useState(!!(reactionsProp ?? post.reactions));

  // Poll state (local cache so vote / unvote feels instant without forcing a
  // parent refresh). Vote API returns the fresh poll snapshot in `{ poll }`.
  const [poll, setPoll] = useState<Poll | null>(post.poll ?? null);
  const [pollLoading, setPollLoading] = useState(false);
  useEffect(() => {
    setPoll(post.poll ?? null);
  }, [post.poll]);

  const submitPollVote = useCallback(async (optionIds: string[]) => {
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
  }, [post.id]);

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

  // Sync reactions when prop changes
  useEffect(() => {
    if (reactionsProp !== undefined) {
      setReactions(reactionsProp);
      setReactionsLoaded(true);
    }
  }, [reactionsProp]);

  // Fetch reactions on mount if not loaded (only in rich mode)
  useEffect(() => {
    if (!hasRichFeatures || reactionsLoaded) return;
    let cancelled = false;
    fetch(`/api/posts/${post.id}/reactions`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data?.reactions) {
          setReactions(data.reactions);
          setReactionsLoaded(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [post.id, reactionsLoaded, hasRichFeatures]);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!showDeleteConfirm) {
      setShowDeleteConfirm(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/posts/${post.id}`, { method: 'DELETE' });
      if (res.ok) {
        onDelete?.(post.id);
      }
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}${href}`;
    if (navigator.share) {
      try { await navigator.share({ title: post.title, url }); return; } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setShareText('Copied!');
    setTimeout(() => setShareText(null), 1500);
  };

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
  const resolvedUserVoted = userVoted ?? post.userVoted;
  const resolvedAuthorId = authorId ?? post.authorId;

  // Record state
  const [recording, setRecording] = useState(false);
  const [recordCount, setRecordCount] = useState(post.recordCount ?? 0);
  const [recorded, setRecorded] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Check if user already recorded this post
  useEffect(() => {
    if (!hasRichFeatures || !sessionUserId || sessionUserId === resolvedAuthorId) return;
    fetch(`/api/posts/${post.id}/records`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          setRecorded(data.userRecorded ?? false);
          setRecordCount(data.recordCount ?? post.recordCount ?? 0);
        }
      })
      .catch(() => {});
  }, [post.id, sessionUserId, resolvedAuthorId, hasRichFeatures]);

  const handleRecord = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (recording || recorded) return;
    // Recording is an irreversible on-chain action — confirm before
    // spending a service-wallet gas slot. Same wording as the mobile
    // Alert so the UX reads the same way across platforms.
    const ok = window.confirm(
      'Record this post on-chain?\n\n' +
        "This writes a permanent on-chain attestation on Base via OpenStoa's service wallet (no fee charged to you). It can take 5–15 seconds to confirm and cannot be undone.",
    );
    if (!ok) return;
    setRecording(true);
    setRecordError(null);
    try {
      const res = await fetch(`/api/posts/${post.id}/record`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setRecordError(data.error ?? 'Failed to record');
        return;
      }
      setRecorded(true);
      setRecordCount(data.record?.recordCount ?? recordCount + 1);
      onRecord?.(post.id);
    } catch {
      setRecordError('Failed to record');
    } finally {
      setRecording(false);
    }
  };

  const isTopicCreator = sessionUserId && topicCreatorId && sessionUserId === topicCreatorId;
  const visibleReactions = reactions.filter((r) => r.count > 0);

  // Topic breadcrumb element (reused in both modes)
  const topicBreadcrumb = showTopic && post.topicTitle && post.topicId ? (
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
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.8'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
      >
        t/{post.topicTitle}
      </Link>
    </div>
  ) : null;

  // ─── Simple mode (My page) ──────────────────────────────────────────────
  if (!hasRichFeatures) {
    return (
      <Link
        href={href}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        <article
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            transition: 'background 0.12s',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          {/* Topic breadcrumb */}
          {topicBreadcrumb}

          {/* Title */}
          <h3 style={{
            fontSize: 15,
            fontWeight: 700,
            margin: '0 0 6px 0',
            letterSpacing: '-0.01em',
            color: '#e5e7eb',
            lineHeight: 1.4,
          }}>
            {post.title}
          </h3>

          {/* Content preview */}
          <div style={{ marginBottom: 10 }}>
            <SNSContent
              html={post.content}
              mediaImages={post.media?.images}
              mediaVideos={post.media?.videos}
              truncate={!expanded}
              maxLines={3}
              onToggleExpand={handleToggleExpand}
              onOverflowChange={setContentOverflows}
            />
          </div>

          {/* Media gallery — compact thumbnails. Show when content overflows
              OR whenever the post has explicit media attached (new posts with
              short text + images shouldn't hide the gallery). */}
          {!expanded && (() => {
            const mediaItems = extractMediaPreview(post);
            if (mediaItems.length === 0) return null;
            const hasExplicitMedia = (post.media?.images?.length ?? 0) > 0 || (post.media?.videos?.length ?? 0) > 0;
            if (!contentOverflows && !hasExplicitMedia) return null;

            const displayItems = mediaItems.slice(0, 3);
            const remaining = mediaItems.length - 3;

            return (
              <div style={{
                display: 'flex',
                gap: 6,
                marginTop: 8,
              }}>
                {displayItems.map((item, i) => (
                  <div key={i} style={{
                    position: 'relative',
                    width: 80,
                    height: 80,
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    flexShrink: 0,
                  }}>
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    ) : (
                      <div style={{
                        width: '100%', height: '100%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#6b7280', fontSize: 12,
                      }}>
                        Video
                      </div>
                    )}
                    {(item.type === 'youtube' || item.type === 'vimeo') && (
                      <div style={{
                        position: 'absolute', top: '50%', left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: 28, height: 28,
                        background: 'rgba(0,0,0,0.6)',
                        borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <span style={{ color: '#fff', fontSize: 12, marginLeft: 2 }}>&#9654;</span>
                      </div>
                    )}
                    {i === 2 && remaining > 0 && (
                      <div style={{
                        position: 'absolute', inset: 0,
                        background: 'rgba(0,0,0,0.6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: 14, fontWeight: 600,
                      }}>
                        +{remaining}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Poll (simple mode) — stop propagation so vote buttons don't trigger Link */}
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

          {/* Tag chips — Title → Body → Media → Poll → Tags */}
          <TagChipRow tags={post.tags ?? []} />

          {/* Meta row */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 12,
            color: '#6b7280',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowUpIcon size={14} />
              {post.upvoteCount ?? 0}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CommentIcon size={14} />
              {post.commentCount ?? 0}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <EyeIcon size={14} />
              {post.viewCount ?? 0}
            </span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
              {relativeTime(post.createdAt)}
            </span>
          </div>
        </article>
      </Link>
    );
  }

  // ─── Rich mode (Topic page) ─────────────────────────────────────────────
  return (
    <article
      style={{
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        transition: 'background 0.12s',
        cursor: 'pointer',
        position: 'relative',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
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

      {/* Topic breadcrumb */}
      {topicBreadcrumb}

      {/* Clicking on the card body navigates; action buttons stop propagation */}
      <Link
        href={href}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        {/* Header: author avatar + nickname + time */}
        {showAuthor && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            <Avatar src={post.authorProfileImage} name={post.authorNickname ?? ''} size={24} style={{ marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: '#e5e7eb' }}>
                  {post.authorNickname}
                </span>
                {post.isAI && <Badge type="ai" />}
                {post.badges && post.badges.length > 0 && post.badges.map((b, i) => (
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

        {/* Title with pin badge */}
        <h3 style={{
          fontSize: 15,
          fontWeight: 700,
          margin: '0 0 6px 0',
          letterSpacing: '-0.01em',
          color: '#e5e7eb',
          lineHeight: 1.4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          {resolvedIsPinned && (
            <span style={{ fontSize: 12, flexShrink: 0 }} title="Pinned post">📌</span>
          )}
          {post.title}
        </h3>

        {/* Body preview */}
        <div>
          <SNSContent
            html={post.content}
            mediaImages={post.media?.images}
            mediaVideos={post.media?.videos}
            truncate={expandable ? !expanded : true}
            maxLines={3}
            onToggleExpand={expandable ? handleToggleExpand : undefined}
            onOverflowChange={setContentOverflows}
          />
        </div>

        {/* Media gallery — compact thumbnails. Show when content overflows
            OR whenever the post has explicit media attached. */}
        {!expanded && (() => {
          const mediaItems = extractMediaPreview(post);
          if (mediaItems.length === 0) return null;
          const hasExplicitMedia = (post.media?.images?.length ?? 0) > 0 || (post.media?.videos?.length ?? 0) > 0;
          if (!contentOverflows && !hasExplicitMedia) return null;

          const displayItems = mediaItems.slice(0, 3);
          const remaining = mediaItems.length - 3;

          return (
            <div style={{
              display: 'flex',
              gap: 6,
              marginTop: 8,
            }}>
              {displayItems.map((item, i) => (
                <div key={i} style={{
                  position: 'relative',
                  width: 80,
                  height: 80,
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  flexShrink: 0,
                }}>
                  {item.thumbnail ? (
                    <img
                      src={item.thumbnail}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <div style={{
                      width: '100%', height: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#6b7280', fontSize: 12,
                    }}>
                      Video
                    </div>
                  )}
                  {/* Play icon for videos */}
                  {(item.type === 'youtube' || item.type === 'vimeo') && (
                    <div style={{
                      position: 'absolute', top: '50%', left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 28, height: 28,
                      background: 'rgba(0,0,0,0.6)',
                      borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <span style={{ color: '#fff', fontSize: 12, marginLeft: 2 }}>&#9654;</span>
                    </div>
                  )}
                  {/* +N remaining indicator on last item */}
                  {i === 2 && remaining > 0 && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      background: 'rgba(0,0,0,0.6)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 14, fontWeight: 600,
                    }}>
                      +{remaining}
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </Link>

      {/* Poll (rich mode) — outside the Link so radio/checkbox clicks
          don't trigger the card-level navigation. */}
      {poll && (
        <PollRenderer
          poll={poll}
          onVote={submitPollVote}
          onUnvote={clearPollVote}
          loading={pollLoading}
        />
      )}

      {/* Tag chips — appear after media/poll, before the action bar.
          Matches the new Title → Body → Media → Poll → Tags order. */}
      <TagChipRow tags={post.tags ?? []} />

      {/* Recorded on Base badge */}
      {recordCount > 0 && (
        <div style={{
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
        }}>
          <RecordIcon size={12} />
          <span>Recorded on Base</span>
          <span style={{ color: '#6b7280' }}>|</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{recordCount} record{recordCount !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Reaction stats (read-only in list view) */}
      {visibleReactions.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 8,
          flexWrap: 'wrap',
        }}>
          {visibleReactions.map((r) => (
            <span
              key={r.emoji}
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 9999,
                padding: '2px 8px',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: '#9ca3af',
              }}
            >
              <span>{r.emoji}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Action bar — outside Link to allow independent clicks */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        marginTop: 6,
      }}>
        {/* Vote pill — display-only here (interactive voting lives on the
            post detail page). Keep the same Reddit/HN style as detail so
            the visual is consistent across surfaces. */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 16,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            marginRight: 8,
          }}
        >
          <ArrowUpIcon size={14} filled={resolvedUserVoted === 1} />
          <span
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              fontWeight: resolvedUserVoted ? 700 : 600,
              color:
                resolvedUserVoted === 1
                  ? '#22c55e'
                  : resolvedUserVoted === -1
                  ? '#3b82f6'
                  : 'var(--muted)',
              minWidth: 14,
              textAlign: 'center',
            }}
          >
            {post.upvoteCount ?? 0}
          </span>
          <ArrowDownIcon size={14} filled={resolvedUserVoted === -1} />
        </div>

        {/* Comment */}
        <ActionButton
          icon={<CommentIcon />}
          count={post.commentCount ?? 0}
        />

        {/* View count */}
        {(post.viewCount ?? 0) > 0 && (
          <ActionButton
            icon={<EyeIcon size={16} />}
            count={post.viewCount}
          />
        )}

        {/* Share */}
        <ActionButton
          icon={<ShareIcon />}
          label={shareText ?? undefined}
          color="var(--accent)"
          active={!!shareText}
          onClick={handleShare}
        />

        {/* Record on-chain */}
        {sessionUserId && sessionUserId !== resolvedAuthorId && (
          <ActionButton
            icon={<RecordIcon />}
            count={recordCount > 0 ? recordCount : undefined}
            color="#8b5cf6"
            active={recorded}
            label={recording ? 'Recording...' : recorded ? 'Recorded' : recordError ?? undefined}
            onClick={handleRecord}
          />
        )}

        <div style={{ flex: 1 }} />

        {/* Bookmark placeholder */}
        <ActionButton
          icon={<BookmarkIcon />}
        />

        {/* Delete (author only) */}
        {sessionUserId && sessionUserId === resolvedAuthorId && (
          <ActionButton
            icon={<TrashIcon />}
            color="#ef4444"
            label={showDeleteConfirm ? (deleting ? 'Deleting...' : 'Delete?') : undefined}
            active={showDeleteConfirm}
            onClick={handleDelete}
          />
        )}
      </div>
    </article>
  );
}
