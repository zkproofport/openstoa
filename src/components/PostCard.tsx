'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import SNSContent from '@/components/SNSContent';
import Avatar from '@/components/Avatar';
import { relativeTime } from '@/lib/utils';
import { HeartIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, TrashIcon, PinIcon, RecordIcon } from '@/components/icons';

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

// ─── Reaction Emojis ─────────────────────────────────────────────────────────

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

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
  expandable = false,
}: PostCardProps) {
  // Determine if we have "rich" features (topic-page mode)
  const hasRichFeatures = showAuthor || reactionsProp !== undefined || onDelete || onPin;

  // State for rich features
  const [shareText, setShareText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Reactions state
  const [reactions, setReactions] = useState<Reaction[]>(reactionsProp ?? post.reactions ?? []);
  const [showAllEmojis, setShowAllEmojis] = useState(false);
  const [reactionsLoaded, setReactionsLoaded] = useState(!!(reactionsProp ?? post.reactions));

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

  const handleReaction = async (e: React.MouseEvent, emoji: string) => {
    e.preventDefault();
    e.stopPropagation();
    setReactions((prev) => {
      const existing = prev.find((r) => r.emoji === emoji);
      if (existing) {
        if (existing.userReacted) {
          const newCount = existing.count - 1;
          return newCount <= 0
            ? prev.filter((r) => r.emoji !== emoji)
            : prev.map((r) => r.emoji === emoji ? { ...r, count: newCount, userReacted: false } : r);
        } else {
          return prev.map((r) => r.emoji === emoji ? { ...r, count: r.count + 1, userReacted: true } : r);
        }
      } else {
        return [...prev, { emoji, count: 1, userReacted: true }];
      }
    });
    try {
      await fetch(`/api/posts/${post.id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
    } catch {
      fetch(`/api/posts/${post.id}/reactions`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (data?.reactions) setReactions(data.reactions); })
        .catch(() => {});
    }
  };

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
              truncate={!expanded}
              maxLines={3}
              onToggleExpand={handleToggleExpand}
            />
          </div>

          {/* Meta row */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 12,
            color: '#6b7280',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <HeartIcon size={14} />
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: '#e5e7eb' }}>
                  {post.authorNickname}
                </span>
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
            truncate={expandable ? !expanded : true}
            maxLines={3}
            onToggleExpand={expandable ? handleToggleExpand : undefined}
          />
        </div>
      </Link>

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

      {/* Reactions bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 8,
        flexWrap: 'wrap',
      }}>
        {visibleReactions.map((r) => (
          <button
            key={r.emoji}
            onClick={(e) => handleReaction(e, r.emoji)}
            style={{
              background: r.userReacted ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
              border: r.userReacted ? '1px solid rgba(59,130,246,0.3)' : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 9999,
              padding: '2px 8px',
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: r.userReacted ? 'var(--accent)' : '#9ca3af',
              transition: 'all 0.12s',
            }}
          >
            <span>{r.emoji}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.count}</span>
          </button>
        ))}
        {/* Add reaction button */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowAllEmojis((v) => !v); }}
            style={{
              background: showAllEmojis ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 9999,
              padding: '2px 8px',
              fontSize: 12,
              cursor: 'pointer',
              color: '#6b7280',
              transition: 'all 0.12s',
            }}
          >
            +
          </button>
          {showAllEmojis && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: '#1a1a1a',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: '4px 6px',
              display: 'flex',
              gap: 2,
              zIndex: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}>
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={(e) => { handleReaction(e, emoji); setShowAllEmojis(false); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 16,
                    cursor: 'pointer',
                    padding: '4px 6px',
                    borderRadius: 4,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Action bar — outside Link to allow independent clicks */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        marginTop: 6,
      }}>
        {/* Like */}
        <ActionButton
          icon={<HeartIcon filled={resolvedUserVoted === 1} />}
          count={post.upvoteCount ?? 0}
          color="#ef4444"
          active={resolvedUserVoted === 1}
        />

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
