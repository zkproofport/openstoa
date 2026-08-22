'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useEffect, useState } from 'react';
import { CommentIcon, EyeIcon, ShareIcon, TrashIcon, RecordIcon } from '@/components/icons';
import VotePill from './VotePill';
import BookmarkButton from './BookmarkButton';
import { usePostMutations, type RecordState, type VoteState } from '@/hooks/usePostMutations';

interface PostActionBarProps {
  postId: string;
  href: string;
  upvoteCount: number;
  userVoted?: number | null;
  commentCount?: number;
  viewCount?: number;
  recordCount?: number;
  userRecorded?: boolean;
  bookmarked?: boolean;
  /** Used to decide whether the author-only delete affordance shows. */
  authorId?: string;
  sessionUserId?: string | null;
  /** Guests get no interactive buttons except Share. */
  isGuest?: boolean;
  /** Layout: compact = list rows, expanded = detail page. */
  variant?: 'list' | 'detail';
  /** Detail-only: the actual comment list lives on the detail page,
   *  so its count comes directly from the rendered comments array. */
  commentLabel?: string;
  /** Author / topic-creator delete handler (PostCard's existing flow). */
  onDelete?: (postId: string) => void;
  /** Notify the parent feed when totals shift so list-level state can update. */
  onVoteChange?: (next: VoteState) => void;
  onRecordChange?: (next: RecordState) => void;
}

// One action bar to rule them all — used by PostCard list rows AND the
// detail page so the affordances (vote pill, comment, view, share,
// record, bookmark, delete) read the same way on every surface.
export default function PostActionBar({
  postId,
  href,
  upvoteCount,
  userVoted,
  commentCount = 0,
  viewCount = 0,
  recordCount: recordCountProp = 0,
  userRecorded,
  bookmarked,
  authorId,
  sessionUserId,
  isGuest,
  variant = 'list',
  commentLabel,
  onDelete,
  onVoteChange,
  onRecordChange,
}: PostActionBarProps) {
  const [shareText, setShareText] = useState<string | null>(null);
  const [recordState, setRecordState] = useState<RecordState>({
    recorded: !!userRecorded,
    recordCount: recordCountProp,
  });
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { record } = usePostMutations(postId);

  useEffect(() => {
    setRecordState({
      recorded: !!userRecorded,
      recordCount: recordCountProp,
    });
  }, [userRecorded, recordCountProp]);

  // Lazy-fetch record state when the parent didn't pre-populate it
  // (lists usually don't include `userRecorded`). Skipped if we're the
  // author — recording one's own post is server-rejected anyway.
  useEffect(() => {
    if (variant !== 'list' || !sessionUserId || sessionUserId === authorId) return;
    if (typeof userRecorded === 'boolean') return;
    let cancelled = false;
    apiFetch(`/api/posts/${postId}/records`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setRecordState({
            recorded: !!data.userRecorded,
            recordCount: data.recordCount ?? recordCountProp,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [postId, variant, sessionUserId, authorId, userRecorded, recordCountProp]);

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}${href}`;
    if (navigator.share) {
      try {
        await navigator.share({ url });
        return;
      } catch {}
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

  const handleRecord = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (recording || recordState.recorded) return;
    const ok = window.confirm(
      'Record this post on-chain?\n\n' +
        "This writes a permanent on-chain attestation on Base via OpenStoa's service wallet (no fee charged to you). It can take 5–15 seconds to confirm and cannot be undone.",
    );
    if (!ok) return;
    setRecording(true);
    setRecordError(null);
    try {
      const res = await record(recordState);
      if (res.ok) {
        setRecordState(res.next);
        onRecordChange?.(res.next);
      } else {
        setRecordError(res.error ?? 'Failed to record');
      }
    } finally {
      setRecording(false);
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
      const res = await apiFetch(`/api/posts/${postId}`, { method: 'DELETE' });
      if (res.ok) onDelete?.(postId);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const isAuthor = !!sessionUserId && sessionUserId === authorId;
  const canRecord = !!sessionUserId && sessionUserId !== authorId && !isGuest;

  const compact = variant === 'list';
  const gap = compact ? 0 : 18;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        marginTop: compact ? 6 : 0,
      }}
    >
      <VotePill
        postId={postId}
        upvoteCount={upvoteCount}
        userVoted={userVoted}
        disabled={isGuest}
        onChange={onVoteChange}
        size={compact ? 'sm' : 'md'}
      />

      <ActionGlyph
        icon={<CommentIcon size={compact ? 16 : 18} />}
        label={commentLabel ?? (commentCount > 0 ? String(commentCount) : undefined)}
        compact={compact}
      />

      {viewCount > 0 && (
        <ActionGlyph
          icon={<EyeIcon size={compact ? 14 : 16} />}
          label={String(viewCount)}
          compact={compact}
        />
      )}

      <ActionGlyph
        icon={<ShareIcon size={compact ? 14 : 18} />}
        label={shareText ?? undefined}
        onClick={handleShare}
        active={!!shareText}
        color="var(--accent)"
        compact={compact}
      />

      {canRecord && (
        <ActionGlyph
          icon={<RecordIcon size={compact ? 14 : 16} />}
          label={
            recording
              ? 'Recording...'
              : recordState.recorded
              ? 'Recorded'
              : recordError ??
                (recordState.recordCount > 0 ? String(recordState.recordCount) : undefined)
          }
          // On-chain stays the quietest affordance in the bar — no brand
          // color, just a step up from the idle tertiary so hover still reads.
          color="var(--color-text-secondary)"
          active={recordState.recorded}
          onClick={handleRecord}
          compact={compact}
        />
      )}

      <div style={{ flex: 1 }} />

      {!isGuest && (
        <BookmarkButton
          postId={postId}
          bookmarked={bookmarked}
          size={compact ? 'sm' : 'md'}
        />
      )}

      {isAuthor && !isGuest && (
        <ActionGlyph
          icon={<TrashIcon size={compact ? 14 : 18} />}
          label={showDeleteConfirm ? (deleting ? 'Deleting...' : 'Delete?') : undefined}
          active={showDeleteConfirm}
          color="var(--color-status-danger)"
          onClick={handleDelete}
          compact={compact}
        />
      )}
    </div>
  );
}

// ─── Internal glyph button (shared style with ActionButton in PostCard) ──────

function ActionGlyph({
  icon,
  label,
  onClick,
  color,
  active,
  compact,
}: {
  icon: React.ReactNode;
  label?: string;
  onClick?: (e: React.MouseEvent) => void;
  color?: string;
  active?: boolean;
  compact?: boolean;
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
        // `color` is now a token (`var(--...)`), so the old `${activeColor}15`
        // alpha-suffix trick no longer produces valid CSS — the hover ground is
        // a surface token instead.
        background: hovered ? 'var(--color-bg-secondary)' : 'none',
        border: 'none',
        color: active || hovered ? activeColor : 'var(--color-text-tertiary)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: compact ? '5px 10px' : '6px 10px',
        borderRadius: 'var(--radius-pill)',
        fontSize: compact ? 12 : 14,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        transition: 'color 0.12s, background 0.12s',
        userSelect: 'none',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
