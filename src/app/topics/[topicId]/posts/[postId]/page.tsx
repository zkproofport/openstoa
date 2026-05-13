'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import Avatar from '@/components/Avatar';
import Badge from '@/components/Badge';
import SNSContent from '@/components/SNSContent';
import Spinner from '@/components/Spinner';
import ImageLightbox from '@/components/ImageLightbox';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, TrashIcon } from '@/components/icons';
import { PostRecordsSection } from '@/components/PostRecordsSection';
import PollRenderer from '@/components/PollRenderer';
import SNSEditor, { type SNSEditorState } from '@/components/SNSEditor';
import TagInput from '@/components/TagInput';
import PollEditor, { type PollEditorValue } from '@/components/PollEditor';
import type { Poll } from '@/lib/polls';
import { formatDate, truncateId } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Post {
  id: string;
  title: string;
  content: string;
  /** Phase A2 unified media. Renderer unions this with whatever can still be
   *  extracted from legacy HTML in `content`. */
  media?: { images?: string[]; videos?: string[] } | null;
  authorNickname: string;
  authorProfileImage?: string | null;
  authorId: string;
  createdAt: string;
  topicId: string;
  topicTitle?: string;
  upvoteCount: number;
  viewCount: number;
  commentCount: number;
  tags?: { name: string; slug: string }[];
  userVoted?: number | null;
  isAI?: boolean;
  poll?: Poll | null;
  /** On-chain record count — when > 0 the post is locked for edits. */
  recordCount?: number;
  /** Soft-delete flag from the API. */
  isDeleted?: boolean;
}

interface Comment {
  id: string;
  content: string;
  authorNickname: string | null;
  authorProfileImage?: string | null;
  authorId: string | null;
  createdAt: string;
  badges?: Array<{ type: string; label: string; domain?: string; country?: string }>;
  isDeleted?: boolean;
  deletedBy?: string | null;
  isAI?: boolean;
}

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PostPage() {
  const params = useParams();
  const router = useRouter();
  const topicId = params.topicId as string;
  const postId = params.postId as string;

  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [commentContent, setCommentContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  const [userVote, setUserVote] = useState<number | null>(null);
  const [upvoteCount, setUpvoteCount] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [voteLoading, setVoteLoading] = useState(false);
  const [shared, setShared] = useState(false);

  const [reactions, setReactions] = useState<{ emoji: string; count: number; userReacted: boolean }[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Poll state — initialised from the GET response, then updated locally on
  // every vote/unvote so the user sees results without a full reload.
  const [poll, setPoll] = useState<Poll | null>(null);
  const [pollLoading, setPollLoading] = useState(false);

  async function handlePollVote(optionIds: string[]) {
    if (isGuest) return;
    setPollLoading(true);
    try {
      const res = await fetch(`/api/posts/${postId}/poll/vote`, {
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
  }

  async function handlePollUnvote() {
    if (isGuest) return;
    setPollLoading(true);
    try {
      const res = await fetch(`/api/posts/${postId}/poll/vote`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Unvote failed');
      }
      const data = await res.json();
      if (data.poll) setPoll(data.poll);
    } finally {
      setPollLoading(false);
    }
  }

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);

  // Guest mode
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  // Post actions menu (kebab) + edit/delete state
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editorState, setEditorState] = useState<SNSEditorState>({ content: '', images: [], videos: [] });
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editPoll, setEditPoll] = useState<PollEditorValue | null>(null);
  const [editPollHadVotes, setEditPollHadVotes] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [postDeleting, setPostDeleting] = useState(false);

  function handleImageClick(src: string) {
    if (window.innerWidth <= 768 || 'ontouchstart' in window) {
      setLightboxSrc(src);
    } else {
      window.open(src, '_blank');
    }
  }

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) {
          setIsGuest(true);
        } else {
          setCurrentUserId(data.userId);
          setCurrentUserRole(typeof data.role === 'string' ? data.role : null);
        }
      })
      .catch(() => {
        setIsGuest(true);
      })
      .finally(() => {
        setSessionChecked(true);
      });
  }, []);

  useEffect(() => {
    loadPost();
    // Only check bookmark status for authenticated users
    fetch(`/api/posts/${postId}/bookmark`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBookmarked(data.bookmarked); })
      .catch(() => {});
    // Fetch reactions
    fetch(`/api/posts/${postId}/reactions`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.reactions) setReactions(data.reactions); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // Attach click handler via event delegation on content area
  useEffect(() => {
    const container = contentAreaRef.current;
    if (!container) return;

    // Style all images as clickable
    const imgs = container.querySelectorAll<HTMLImageElement>('.sns-content-body img');
    imgs.forEach(img => { img.style.cursor = 'zoom-in'; });

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'IMG') {
        const src = (target as HTMLImageElement).src;
        const isMobile = window.innerWidth <= 768 || 'ontouchstart' in window;
        if (isMobile) {
          setLightboxSrc(src);
        } else {
          window.open(src, '_blank');
        }
      }
    }

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [post]);

  async function loadPost() {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      if (res.status === 401) {
        // Guest on a non-public topic
        router.replace('/topics');
        return;
      }
      if (res.status === 403) {
        router.replace('/topics');
        return;
      }
      if (res.status === 404) {
        setError('Post not found');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error('Post not found');
      const data = await res.json();
      setPost(data.post);
      setComments(data.comments ?? []);
      setUpvoteCount(data.post.upvoteCount ?? 0);
      setUserVote(data.post.userVoted ?? null);
      setPoll(data.post.poll ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load post');
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(value: 1 | -1) {
    if (voteLoading || isGuest) return;
    setVoteLoading(true);
    try {
      const res = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (res.ok) {
        const data = await res.json();
        setUserVote(data.vote?.value ?? null);
        setUpvoteCount(data.upvoteCount);
      }
    } catch (err) {
      console.error('Vote failed:', err);
    } finally {
      setVoteLoading(false);
    }
  }

  async function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: post?.title ?? '', url });
        return;
      } catch {}
    }
    await navigator.clipboard.writeText(url);
    setShared(true);
    setTimeout(() => setShared(false), 1500);
  }

  async function handleBookmark() {
    if (isGuest) return;
    try {
      const res = await fetch(`/api/posts/${postId}/bookmark`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setBookmarked(data.bookmarked);
      }
    } catch (err) {
      console.error('Bookmark failed:', err);
    }
  }

  async function handleReaction(emoji: string) {
    if (isGuest) return;
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
      await fetch(`/api/posts/${postId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
    } catch {
      // Re-fetch on error
      fetch(`/api/posts/${postId}/reactions`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (data?.reactions) setReactions(data.reactions); })
        .catch(() => {});
    }
  }

  async function handleCommentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!commentContent.trim() || isGuest) return;
    setSubmitting(true);
    setCommentError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentContent.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to post comment');
      }
      const data = await res.json();
      setComments((prev) => [...prev, data.comment]);
      setCommentContent('');
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  function openEdit() {
    if (!post) return;
    setEditTitle(post.title);
    setEditorState({
      content: post.content,
      images: post.media?.images ?? [],
      videos: post.media?.videos ?? [],
    });
    setEditTags((post.tags ?? []).map((t) => t.name));
    if (post.poll) {
      const hadVotes = (post.poll.totalVotes ?? 0) > 0
        || (post.poll.options ?? []).some((o) => (o.voteCount ?? 0) > 0);
      setEditPollHadVotes(hadVotes);
      setEditPoll({
        question: post.poll.question ?? '',
        options: post.poll.options?.map((o) => o.text) ?? ['', ''],
        multipleChoice: !!post.poll.multipleChoice,
        closesAt: post.poll.closesAt ?? null,
      });
    } else {
      setEditPoll(null);
      setEditPollHadVotes(false);
    }
    setEditError(null);
    setEditing(true);
    setMenuOpen(false);
  }

  function cancelEdit() {
    setEditing(false);
    setEditError(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!post || editSaving) return;
    if (!editTitle.trim()) {
      setEditError('Title is required');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      // Build poll payload — same shape as POST. When the existing poll
      // has votes we DO NOT send the `options` field so the server-side
      // guard doesn't refuse the edit.
      let pollPayload: { question?: string; options?: string[]; multipleChoice?: boolean; closesAt?: string | null } | null | undefined;
      if (editPoll === null) {
        pollPayload = null;
      } else if (editPoll) {
        const opts = editPoll.options.map((o) => o.trim()).filter((o) => o.length > 0 && o.length <= 80);
        if (!editPollHadVotes && (opts.length < 2 || opts.length > 4)) {
          throw new Error('Poll needs 2 to 4 non-empty options (≤80 chars each)');
        }
        pollPayload = {
          ...(editPoll.question?.trim() ? { question: editPoll.question.trim() } : { question: '' }),
          multipleChoice: editPoll.multipleChoice,
          closesAt: editPoll.closesAt ?? null,
          ...(editPollHadVotes ? {} : { options: opts }),
        };
      }

      const body: Record<string, unknown> = {
        title: editTitle.trim(),
        content: editorState.content,
        media: { images: editorState.images, videos: editorState.videos },
        tags: editTags,
      };
      if (pollPayload !== undefined) body.poll = pollPayload;

      const res = await fetch(`/api/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Locked after on-chain record');
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to save');
      }
      setEditing(false);
      await loadPost();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeletePost() {
    if (!post || postDeleting) return;
    const ok = window.confirm('정말 이 글을 삭제하시겠어요? / Delete this post?');
    if (!ok) return;
    setPostDeleting(true);
    try {
      const res = await fetch(`/api/posts/${postId}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to delete');
      }
      router.replace(`/topics/${topicId}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setPostDeleting(false);
      setMenuOpen(false);
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (deletingCommentId) return;
    setDeletingCommentId(commentId);
    try {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        setComments((prev) =>
          prev.map((c) =>
            c.id === commentId
              ? { ...c, isDeleted: true, deletedBy: data.deletedBy, content: '', authorNickname: null, authorProfileImage: null, authorId: null, badges: [] }
              : c,
          ),
        );
      }
    } catch (err) {
      console.error('Delete comment failed:', err);
    } finally {
      setDeletingCommentId(null);
    }
  }

  if (loading) {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (error || !post) {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'var(--font-mono)', fontSize: 14, marginBottom: 16 }}>
            {error ?? 'Post not found'}
          </p>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--accent)', fontSize: 14 }}>
            ← Back to topic
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
      topicId={topicId}
      topicTitle={post.topicTitle}
      topicDescription=""
    >
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
        {/* Breadcrumb */}
        <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Topics</Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--muted)', textDecoration: 'none' }}>
            {post.topicTitle ?? 'Topic'}
          </Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          <span style={{
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {post.title}
          </span>
        </div>

        {/* Guest banner */}
        {isGuest && (
          <div
            style={{
              padding: '10px 16px',
              background: 'rgba(120,140,255,0.06)',
              border: '1px solid rgba(120,140,255,0.12)',
              borderRadius: 8,
              marginBottom: 20,
              fontSize: 14,
              color: '#888',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span>Sign in to vote, comment, and bookmark.</span>
            <Link
              href="/"
              style={{
                color: 'var(--accent)',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 13,
                whiteSpace: 'nowrap',
              }}
            >
              Sign in
            </Link>
          </div>
        )}

        {/* Post */}
        <article
          style={{
            padding: '28px 32px',
            background: 'var(--surface, #0c0e18)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            marginBottom: 32,
            position: 'relative',
          }}
        >
          {/* Actions menu (author + admin only). Visible to anyone who can
              edit/delete; the kebab opens a small popover with Edit and
              Delete buttons. Edit is disabled with a tooltip after the
              post is recorded on-chain. */}
          {(() => {
            const isAuthor = !!currentUserId && post.authorId === currentUserId;
            const isAdmin = currentUserRole === 'admin';
            if (!isAuthor && !isAdmin) return null;
            const recorded = ((post as { recordCount?: number }).recordCount ?? 0) > 0;
            return (
              <div style={{ position: 'absolute', top: 14, right: 14 }}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Post actions"
                  style={{
                    background: menuOpen ? 'rgba(255,255,255,0.06)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: '#9ca3af',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontSize: 18,
                    lineHeight: 1,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      background: 'var(--surface, #0c0e18)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 4,
                      minWidth: 160,
                      boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
                      zIndex: 20,
                    }}
                  >
                    <button
                      type="button"
                      disabled={recorded}
                      onClick={() => !recorded && openEdit()}
                      title={recorded ? '온체인 기록 이후엔 수정할 수 없어요 / Locked after on-chain record' : undefined}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        color: recorded ? '#4b5563' : '#e5e7eb',
                        cursor: recorded ? 'not-allowed' : 'pointer',
                        padding: '8px 12px',
                        borderRadius: 6,
                        fontSize: 13,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      Edit / 수정
                    </button>
                    <button
                      type="button"
                      disabled={postDeleting}
                      onClick={handleDeletePost}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        color: '#ef4444',
                        cursor: postDeleting ? 'not-allowed' : 'pointer',
                        padding: '8px 12px',
                        borderRadius: 6,
                        fontSize: 13,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {postDeleting ? 'Deleting…' : 'Delete / 삭제'}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

          {editing ? (
            <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Post title"
                style={{
                  width: '100%',
                  background: 'var(--surface, #0c0e18)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 7,
                  padding: '10px 14px',
                  color: '#e5e7eb',
                  fontSize: 16,
                  fontWeight: 600,
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                }}
              />
              <SNSEditor
                placeholder="Write your post..."
                onChange={setEditorState}
                minHeight={180}
                draftKey={`openstoa-edit-${postId}`}
                initialState={editorState}
              />
              <TagInput tags={editTags} onChange={setEditTags} topicId={topicId} />
              {editPoll && (
                <>
                  <PollEditor
                    value={editPoll}
                    onChange={(next) => {
                      // When the poll has existing votes, freeze options
                      // client-side too — only question/closesAt/multipleChoice
                      // updates flow through.
                      if (editPollHadVotes) {
                        setEditPoll({ ...next, options: editPoll.options });
                      } else {
                        setEditPoll(next);
                      }
                    }}
                    onRemove={editPollHadVotes ? () => { /* locked — votes exist */ } : () => setEditPoll(null)}
                  />
                  {editPollHadVotes && (
                    <p style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace', margin: 0 }}>
                      Poll options are frozen — votes already exist. Question and closing time can still be updated.
                    </p>
                  )}
                </>
              )}
              {!editPoll && (
                <button
                  type="button"
                  onClick={() => setEditPoll({ question: '', options: ['', ''], multipleChoice: false, closesAt: null })}
                  style={{
                    alignSelf: 'flex-start',
                    background: 'rgba(255,255,255,0.04)',
                    color: '#9ca3af',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 7,
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  Add poll
                </button>
              )}
              {editError && (
                <p style={{ fontSize: 13, color: '#ef4444', margin: 0, fontFamily: 'monospace' }}>{editError}</p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={editSaving}
                  style={{
                    background: 'transparent',
                    color: '#9ca3af',
                    border: '1px solid var(--border)',
                    borderRadius: 7,
                    padding: '9px 18px',
                    fontSize: 14,
                    cursor: editSaving ? 'not-allowed' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSaving || !editTitle.trim()}
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 7,
                    padding: '9px 22px',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: editSaving ? 'not-allowed' : 'pointer',
                    opacity: editSaving ? 0.7 : 1,
                  }}
                >
                  {editSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : (
          <>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              margin: '0 0 14px',
              lineHeight: 1.3,
            }}
          >
            {post.title}
          </h1>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 24,
              paddingBottom: 20,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span
              onClick={() => post.authorProfileImage && handleImageClick(post.authorProfileImage)}
              style={{ cursor: post.authorProfileImage ? 'pointer' : undefined, display: 'inline-flex' }}
            >
              <Avatar src={post.authorProfileImage} name={post.authorNickname || 'U'} size={32} />
            </span>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0, fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
                {post.authorNickname}
                {post.isAI && <Badge type="ai" />}
              </p>
              <p style={{ fontSize: 15, color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
                {truncateId(post.authorId, 6, 4)} · {formatDate(post.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>

          {post.tags && post.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
              {post.tags.map(tag => (
                <span
                  key={tag.slug}
                  style={{
                    background: 'rgba(59,130,246,0.08)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(59,130,246,0.15)',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    lineHeight: 1.6,
                  }}
                >
                  #{tag.name}
                </span>
              ))}
            </div>
          )}

          <div ref={contentAreaRef}>
            <SNSContent
              html={post.content}
              mediaImages={post.media?.images}
              mediaVideos={post.media?.videos}
            />
          </div>

          {poll && (
            <PollRenderer
              poll={poll}
              onVote={handlePollVote}
              onUnvote={handlePollUnvote}
              loading={pollLoading}
            />
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
          }}>
            {/* Vote pill — Reddit/HN style ↑/↓ */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 16,
                background: 'var(--card-bg, rgba(255,255,255,0.03))',
                border: '1px solid var(--border, rgba(255,255,255,0.08))',
              }}
            >
              <button
                type="button"
                onClick={() => !isGuest && handleVote(1)}
                disabled={isGuest || voteLoading}
                aria-label="Upvote"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: isGuest ? 'default' : 'pointer',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                  color: userVote === 1 ? '#22c55e' : 'var(--muted)',
                }}
              >
                <ArrowUpIcon filled={userVote === 1} />
              </button>
              <span
                style={{
                  fontSize: 14,
                  fontFamily: 'var(--font-mono)',
                  minWidth: 16,
                  textAlign: 'center',
                  fontWeight: userVote ? 700 : 600,
                  color:
                    userVote === 1
                      ? '#22c55e'
                      : userVote === -1
                      ? '#3b82f6'
                      : 'var(--muted)',
                }}
              >
                {upvoteCount}
              </span>
              <button
                type="button"
                onClick={() => !isGuest && handleVote(-1)}
                disabled={isGuest || voteLoading}
                aria-label="Downvote"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: isGuest ? 'default' : 'pointer',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                  color: userVote === -1 ? '#3b82f6' : 'var(--muted)',
                }}
              >
                <ArrowDownIcon filled={userVote === -1} />
              </button>
            </div>

            {/* Comments */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontFamily: 'var(--font-mono)' }}>
              <CommentIcon />
              {comments.length}
            </span>

            {/* Views */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontFamily: 'var(--font-mono)' }}>
              <EyeIcon size={16} />
              {post.viewCount}
            </span>

            {/* Share — always available */}
            <button
              type="button"
              onClick={handleShare}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: shared ? 'var(--accent)' : 'var(--muted)',
                fontSize: 14,
                fontFamily: 'var(--font-mono)',
                padding: 0,
                transition: 'color 0.15s',
              }}
            >
              <ShareIcon size={18} />
              {shared && 'Copied!'}
            </button>

            <div style={{ flex: 1 }} />

            {/* Bookmark — hidden for guests */}
            {!isGuest && (
              <button
                type="button"
                onClick={handleBookmark}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: bookmarked ? 'var(--accent)' : 'var(--muted)',
                  fontSize: 14,
                  padding: 0,
                  transition: 'color 0.15s',
                }}
              >
                <BookmarkIcon filled={bookmarked} />
              </button>
            )}
          </div>

          {/* Emoji Reactions */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}>
            {reactions.filter(r => r.count > 0).map((r) => (
              <button
                key={r.emoji}
                onClick={() => !isGuest && handleReaction(r.emoji)}
                style={{
                  background: r.userReacted ? 'rgba(120,140,255,0.15)' : 'rgba(255,255,255,0.05)',
                  border: r.userReacted ? '1px solid rgba(120,140,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 9999,
                  padding: '4px 12px',
                  fontSize: 14,
                  cursor: isGuest ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: r.userReacted ? 'var(--accent)' : '#9ca3af',
                  transition: 'all 0.12s',
                }}
              >
                <span>{r.emoji}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.count}</span>
              </button>
            ))}
            {/* Add reaction button — hidden for guests */}
            {!isGuest && (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowEmojiPicker(v => !v)}
                  style={{
                    background: showEmojiPicker ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 9999,
                    padding: '4px 12px',
                    fontSize: 14,
                    cursor: 'pointer',
                    color: '#6b7280',
                    transition: 'all 0.12s',
                  }}
                >
                  +
                </button>
                {showEmojiPicker && (
                  <div style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: 0,
                    marginBottom: 6,
                    background: 'var(--surface, #1a1a2e)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 10,
                    padding: '6px 8px',
                    display: 'flex',
                    gap: 2,
                    zIndex: 10,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                  }}>
                    {REACTION_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => { handleReaction(emoji); setShowEmojiPicker(false); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: 20,
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: 6,
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
            )}
          </div>
          </>
          )}
        </article>

        {/* On-chain record receipts (collapsible) — sits between the
            post body and the comments so it's discoverable without
            pushing comments off the page. */}
        <PostRecordsSection
          postId={post.id}
          recordCount={(post as { recordCount?: number }).recordCount ?? 0}
        />

        {/* Comments section */}
        <div>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: '0 0 16px',
            }}
          >
            {comments.length > 0
              ? `${comments.length} Comment${comments.length !== 1 ? 's' : ''}`
              : 'Comments'}
          </h2>

          {comments.length > 0 && (
            <div className="flex flex-col gap-3" style={{ marginBottom: 24 }}>
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: comment.isDeleted ? '12px 16px' : '16px 20px',
                    background: comment.isDeleted ? 'rgba(255,255,255,0.02)' : 'var(--surface, #0c0e18)',
                    border: comment.isDeleted ? '1px solid rgba(255,255,255,0.04)' : '1px solid var(--border)',
                    borderRadius: comment.isDeleted ? 8 : 10,
                  }}
                >
                  {comment.isDeleted ? (
                    <p style={{
                      margin: 0,
                      color: '#6b7280',
                      fontStyle: 'italic',
                      fontSize: 14,
                    }}>
                      {comment.deletedBy === 'admin' ? 'Deleted by admin' : 'Deleted comment'}
                    </p>
                  ) : (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <span
                          onClick={() => comment.authorProfileImage && handleImageClick(comment.authorProfileImage)}
                          style={{ cursor: comment.authorProfileImage ? 'pointer' : undefined, display: 'inline-flex' }}
                        >
                          <Avatar src={comment.authorProfileImage} name={comment.authorNickname || 'U'} size={26} />
                        </span>
                        <div style={{ flex: 1 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                              {comment.authorNickname}
                            </span>
                            {comment.isAI && <Badge type="ai" />}
                            {comment.badges && comment.badges.length > 0 && comment.badges.map((b, i) => (
                              <Badge key={i} type={b.type} label={b.label} domain={b.domain} country={b.country} />
                            ))}
                          </span>
                          <span style={{ fontSize: 15, color: 'var(--muted)', marginLeft: 8, fontFamily: 'var(--font-mono)' }}>
                            {truncateId(comment.authorId ?? '', 6, 4)} · {formatDate(comment.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {!isGuest && currentUserId && comment.authorId === currentUserId && (
                          <button
                            type="button"
                            onClick={() => handleDeleteComment(comment.id)}
                            disabled={deletingCommentId === comment.id}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: deletingCommentId === comment.id ? 'not-allowed' : 'pointer',
                              padding: 4,
                              color: 'var(--muted)',
                              opacity: deletingCommentId === comment.id ? 0.5 : 0.6,
                              transition: 'opacity 0.15s',
                              flexShrink: 0,
                            }}
                            title="Delete comment"
                          >
                            <TrashIcon size={14} />
                          </button>
                        )}
                      </div>
                      <p
                        style={{
                          fontSize: 14,
                          lineHeight: 1.7,
                          margin: 0,
                          color: 'var(--foreground)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {comment.content}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Comment form — hidden for guests, show sign-in prompt instead */}
          {isGuest ? (
            <div
              style={{
                padding: '20px',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 12px' }}>
                Sign in to join the conversation.
              </p>
              <Link
                href="/"
                style={{
                  color: 'var(--accent)',
                  textDecoration: 'none',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Sign in
              </Link>
            </div>
          ) : (
            <form
              onSubmit={handleCommentSubmit}
              style={{
                padding: '20px',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 12,
              }}
            >
              <label
                htmlFor="comment"
                style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
              >
                Write a comment
              </label>
              <textarea
                id="comment"
                value={commentContent}
                onChange={(e) => setCommentContent(e.target.value)}
                placeholder="Share your thoughts..."
                rows={4}
                style={{
                  width: '100%',
                  background: 'var(--surface, #0c0e18)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  color: 'var(--foreground)',
                  fontSize: 14,
                  outline: 'none',
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontFamily: 'inherit',
                  marginBottom: 8,
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              {commentError && (
                <p style={{ fontSize: 14, color: '#ef4444', margin: '0 0 8px', fontFamily: 'var(--font-mono)' }}>
                  {commentError}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!commentContent.trim() || submitting}
                  style={{
                    background: commentContent.trim() ? 'var(--accent)' : 'var(--border)',
                    color: commentContent.trim() ? '#fff' : 'var(--muted)',
                    border: 'none',
                    borderRadius: 7,
                    padding: '9px 22px',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: commentContent.trim() ? 'pointer' : 'not-allowed',
                    transition: 'all 0.15s',
                  }}
                >
                  {submitting ? 'Posting...' : 'Post Comment'}
                </button>
              </div>
            </form>
          )}
        </div>
    </CommunityLayout>
  );
}
