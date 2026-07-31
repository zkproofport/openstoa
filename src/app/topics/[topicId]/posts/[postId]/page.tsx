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
import { TrashIcon } from '@/components/icons';
import { PostRecordsSection } from '@/components/PostRecordsSection';
import PollRenderer from '@/components/PollRenderer';
import SNSEditor, { type SNSEditorState } from '@/components/SNSEditor';
import TagInput from '@/components/TagInput';
import PollEditor, { type PollEditorValue } from '@/components/PollEditor';
import PostActionBar from '@/components/post/PostActionBar';
import ReactionRow from '@/components/post/ReactionRow';
import MediaGallery from '@/components/post/MediaGallery';
import { collectPostMedia, stripVideoUrls } from '@/lib/postMedia';
import type { ReactionSummary } from '@/hooks/usePostMutations';
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
  /** True when the signed-in viewer is a member of the post's topic.
   *  Mirrors the mobile post detail header — we render a small "Joined"
   *  pill next to the topic chip so the user sees their membership
   *  status without leaving the page. */
  isJoinedTopic?: boolean;
  /** Whether the post is pinned by a topic admin/owner. Rendered as a
   *  small "Pinned" pill (pin SVG + label) in the header row next to topic chip. */
  isPinned?: boolean;
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

  // Vote / bookmark / record live inside the shared PostActionBar; this
  // page only owns the initial values so we can hand them to the bar.
  const [userVote, setUserVote] = useState<number | null>(null);
  const [upvoteCount, setUpvoteCount] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);

  const [reactions, setReactions] = useState<ReactionSummary[]>([]);

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
  // Topic role ('owner' | 'admin' | 'member' | null) — gates the Pin/Unpin
  // menu entry. Fetched separately from session role because session role
  // is platform-wide and only the topic membership grants pin rights.
  const [topicRole, setTopicRole] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
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
    // Fetch the viewer's topic role so we know whether to surface the
    // Pin/Unpin menu entry. 401/403/null all collapse to "no role".
    fetch(`/api/topics/${topicId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.currentUserRole) setTopicRole(data.currentUserRole); })
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

  async function handlePinToggle() {
    if (!post || pinning) return;
    setPinning(true);
    try {
      const res = await fetch(`/api/posts/${postId}/pin`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to toggle pin');
      }
      const data = await res.json();
      setPost((prev) => (prev ? { ...prev, isPinned: !!data.isPinned } : prev));
      setMenuOpen(false);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to toggle pin');
    } finally {
      setPinning(false);
    }
  }

  async function handleDeletePost() {
    if (!post || postDeleting) return;
    const ok = window.confirm('정말 이 글을 삭제하시겠어요?');
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
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 14, marginBottom: 16 }}>
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
              background: 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)',
              borderRadius: 8,
              marginBottom: 20,
              fontSize: 14,
              color: 'var(--color-text-secondary)',
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
            background: 'var(--color-bg-secondary)',
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
            // Pin/Unpin is gated on topic role (owner/admin), not platform role.
            const canPin = topicRole === 'owner' || topicRole === 'admin';
            if (!isAuthor && !isAdmin && !canPin) return null;
            const recorded = ((post as { recordCount?: number }).recordCount ?? 0) > 0;
            return (
              <div style={{ position: 'absolute', top: 14, right: 14 }}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Post actions"
                  style={{
                    // Border removed to match the mobile kebab — the button
                    // is a borderless glyph so it reads as a hit target
                    // without competing with the surrounding card border.
                    background: menuOpen ? 'var(--color-bg-tertiary)' : 'transparent',
                    border: 'none',
                    color: 'var(--color-text-secondary)',
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
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 4,
                      minWidth: 160,
                      boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
                      zIndex: 20,
                    }}
                  >
                    {canPin && (
                      <button
                        type="button"
                        disabled={pinning}
                        onClick={handlePinToggle}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-text-primary)',
                          cursor: pinning ? 'not-allowed' : 'pointer',
                          padding: '8px 12px',
                          borderRadius: 6,
                          fontSize: 13,
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {pinning ? '…' : (post.isPinned ? 'Unpin post' : 'Pin post')}
                      </button>
                    )}
                    {(isAuthor || isAdmin) && (
                      <>
                        <button
                          type="button"
                          disabled={recorded}
                          onClick={() => !recorded && openEdit()}
                          title={recorded ? 'Cannot edit after on-chain recording' : undefined}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            color: recorded ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                            cursor: recorded ? 'not-allowed' : 'pointer',
                            padding: '8px 12px',
                            borderRadius: 6,
                            fontSize: 13,
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          Edit
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
                            color: 'var(--color-status-danger)',
                            cursor: postDeleting ? 'not-allowed' : 'pointer',
                            padding: '8px 12px',
                            borderRadius: 6,
                            fontSize: 13,
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {postDeleting ? 'Deleting…' : 'Delete'}
                        </button>
                      </>
                    )}
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
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 7,
                  padding: '10px 14px',
                  color: 'var(--color-text-primary)',
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
                    <p style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)', margin: 0 }}>
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
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text-secondary)',
                    border: '1px solid var(--color-border-default)',
                    borderRadius: 7,
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Add poll
                </button>
              )}
              {editError && (
                <p style={{ fontSize: 13, color: 'var(--color-status-danger)', margin: 0, fontFamily: 'var(--font-mono)' }}>{editError}</p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={editSaving}
                  style={{
                    background: 'transparent',
                    color: 'var(--color-text-secondary)',
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
                    color: 'var(--color-text-inverted)',
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
          {/* Topic chip + Joined badge — mirrors the mobile PostDetailScreen */}
          {/* header where the topic title appears as a small brand-coloured  */}
          {/* label above the post title, with a "Joined" pill next to it     */}
          {/* when the viewer is a member. Web previously only showed the     */}
          {/* topic in the gray breadcrumb, which made it easy to miss which  */}
          {/* community the post belonged to AND whether the viewer was in.   */}
          {/* Reddit/Threads-style header order: topic chip + Joined pill →
              author avatar/name/time → title. Author row above title makes
              attribution land before content, mirroring the mobile
              PostDetailScreen and ChatRoom message header. */}
          {post.topicTitle ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <Link
                href={`/topics/${topicId}`}
                style={{
                  display: 'inline-block',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                }}
              >
                {post.topicTitle}
              </Link>
              {post.isJoinedTopic && (
                <span
                  // Success-green tint, same intent as the mobile
                  // `joinedBadge` style. Sits inline with the topic chip
                  // so the user reads "TOPIC · Joined" at a glance.
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--color-brand-accent)',
                    background: 'color-mix(in srgb, var(--color-brand-accent) 10%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                    borderRadius: 4,
                    padding: '2px 7px',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1.2,
                  }}
                  aria-label="You are a member of this topic"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Joined
                </span>
              )}
            </div>
          ) : null}

          {/* Author row — sits ABOVE the title (Reddit / Threads pattern).
              Compact avatar + name + meta. Border on the bottom of the
              title row separates the post body from the header. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 14,
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

          <h1
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              margin: '0 0 18px',
              lineHeight: 1.3,
              paddingBottom: 16,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {post.isPinned && (
              // Inline pin icon — vertical-align baseline + capHeight-matched
              // size so the icon's optical center lines up with the title's
              // text x-height (flex+alignItems center over-emphasised the
              // h1's 1.3 line-height extra space and shifted the icon up).
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
            )}
            {post.title}
          </h1>

          {post.tags && post.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 16 }}>
              {post.tags.map(tag => (
                <span
                  key={tag.slug}
                  style={{
                    background: 'color-mix(in srgb, var(--color-brand-primary) 8%, transparent)',
                    color: 'var(--accent)',
                    border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1.6,
                  }}
                >
                  #{tag.name}
                </span>
              ))}
            </div>
          )}

          <div ref={contentAreaRef}>
            {/* Media is rendered by the shared MediaGallery below so the
                detail page mirrors the mobile UX: text body, then a
                swipeable image+video carousel with click-to-zoom. Strip
                bare YouTube/Vimeo URLs from the body so they don't
                surface above the gallery embed.
                `stripInlineImages` removes any inline `<img>` tags from
                the body — the same image is already in MediaGallery, and
                the inline copy was the source of W05's broken-icon bug
                on web (image element rendered inside an HTML body fragment
                without the layout context MediaGallery provides). */}
            <SNSContent html={stripVideoUrls(post.content)} stripInlineImages />
          </div>

          {(() => {
            // Same extraction the feed uses — surfaces legacy YouTube/Vimeo
            // URLs that lived inside HTML body instead of `media.videos`.
            const m = collectPostMedia(post);
            return <MediaGallery images={m.images} videos={m.videos} mode="detail" />;
          })()}

          {poll && (
            <PollRenderer
              poll={poll}
              onVote={handlePollVote}
              onUnvote={handlePollUnvote}
              loading={pollLoading}
            />
          )}

          <div style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
          }}>
            <PostActionBar
              postId={postId}
              href={`/topics/${topicId}/posts/${postId}`}
              upvoteCount={upvoteCount}
              userVoted={userVote}
              commentCount={comments.length}
              viewCount={post.viewCount}
              recordCount={post.recordCount ?? 0}
              bookmarked={bookmarked}
              authorId={post.authorId}
              sessionUserId={currentUserId}
              isGuest={isGuest}
              variant="detail"
              onVoteChange={(v) => {
                setUserVote(v.userVoted);
                setUpvoteCount(v.upvoteCount);
              }}
            />
          </div>

          {/* Emoji reactions — interactive picker lives on the detail page only. */}
          <div style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--border)',
          }}>
            <ReactionRow
              postId={postId}
              reactions={reactions}
              interactive
              disabled={isGuest}
              initialKnown
              onChange={setReactions}
            />
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
                    background: comment.isDeleted ? 'var(--color-bg-secondary)' : 'var(--color-bg-secondary)',
                    border: comment.isDeleted ? '1px solid var(--color-border-default)' : '1px solid var(--border)',
                    borderRadius: comment.isDeleted ? 8 : 10,
                  }}
                >
                  {comment.isDeleted ? (
                    <p style={{
                      margin: 0,
                      color: 'var(--color-text-tertiary)',
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
                      {/* Comment body shares SNSContent with post body so */}
                      {/* plain URLs become <a>, YouTube/Vimeo render as    */}
                      {/* iframes, and LinkPreview surfaces an OG card —    */}
                      {/* the body sits in a <div> rather than a <p> because*/}
                      {/* SNSContent produces <div> children (LinkPreview,  */}
                      {/* MediaImages, VideoEmbeds) that are invalid inside */}
                      {/* a <p>, which causes the browser to break the      */}
                      {/* nesting and visually corrupt the layout.          */}
                      <div
                        style={{
                          fontSize: 14,
                          lineHeight: 1.7,
                          color: 'var(--foreground)',
                          wordBreak: 'break-word',
                        }}
                      >
                        <SNSContent html={comment.content} />
                      </div>
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
                background: 'var(--color-bg-secondary)',
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
                background: 'var(--color-bg-secondary)',
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
                  background: 'var(--color-bg-secondary)',
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
                onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-brand-primary)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              {commentError && (
                <p style={{ fontSize: 14, color: 'var(--color-status-danger)', margin: '0 0 8px', fontFamily: 'var(--font-mono)' }}>
                  {commentError}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!commentContent.trim() || submitting}
                  style={{
                    background: commentContent.trim() ? 'var(--accent)' : 'var(--border)',
                    color: commentContent.trim() ? 'var(--color-text-inverted)' : 'var(--muted)',
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
