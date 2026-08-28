'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
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
import { useTranslation } from '@/lib/i18n/I18nProvider';

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

export default function PostDetailClient() {
  const { t } = useTranslation();
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
      const res = await apiFetch(`/api/posts/${postId}/poll/vote`, {
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
      const res = await apiFetch(`/api/posts/${postId}/poll/vote`, { method: 'DELETE' });
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

  /*
   * Acts once the SERVER has answered — a seeded session is a hint, and a
   * redirect or a guest verdict must not rest on one. The previous code ran
   * only after the fetch settled, and a failed lookup settles as `null`.
   */
  const { session, isVerified } = useSession();

  useEffect(() => {
    if (!isVerified) return;
    if (!session?.userId) {
      setIsGuest(true);
    } else {
      setCurrentUserId(session.userId);
      setCurrentUserRole(typeof session.role === 'string' ? session.role : null);
    }
    setSessionChecked(true);
  }, [session, isVerified]);

  useEffect(() => {
    loadPost();
    // Only check bookmark status for authenticated users
    apiFetch(`/api/posts/${postId}/bookmark`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBookmarked(data.bookmarked); })
      .catch(() => {});
    // Fetch reactions
    apiFetch(`/api/posts/${postId}/reactions`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.reactions) setReactions(data.reactions); })
      .catch(() => {});
    // Fetch the viewer's topic role so we know whether to surface the
    // Pin/Unpin menu entry. 401/403/null all collapse to "no role".
    apiFetch(`/api/topics/${topicId}`)
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
      const res = await apiFetch(`/api/posts/${postId}`);
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
      const res = await apiFetch(`/api/posts/${postId}/comments`, {
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

      const res = await apiFetch(`/api/posts/${postId}`, {
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
      const res = await apiFetch(`/api/posts/${postId}/pin`, { method: 'POST' });
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
      const res = await apiFetch(`/api/posts/${postId}`, { method: 'DELETE' });
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
      const res = await apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' });
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
          <Spinner />
        </div>
      </CommunityLayout>
    );
  }

  if (error || !post) {
    return (
      <CommunityLayout isGuest={isGuest} sessionChecked={sessionChecked}>
        <div style={{ padding: 'var(--space-7) 0', textAlign: 'center' }}>
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)', margin: '0 0 var(--space-4)' }}>
            {error ?? 'Post not found'}
          </p>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
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
        <div style={{
          marginBottom: 'var(--space-5)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          fontSize: 'var(--text-caption)',
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
        }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Topics</Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--muted)', textDecoration: 'none' }}>
            {post.topicTitle ?? 'Topic'}
          </Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          {/* The only place on this page a title is allowed to be clipped:
              it is a trail marker, and the full title is the h1 below. */}
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
              padding: 'var(--space-3) var(--space-4)',
              background: 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)',
              borderRadius: 'var(--radius-control)',
              marginBottom: 'var(--space-5)',
              fontSize: 'var(--text-body-sm)',
              color: 'var(--color-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <span>{t('postDetail.signInToInteract')}</span>
            <Link
              href="/"
              style={{
                color: 'var(--accent)',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 'var(--text-caption)',
                whiteSpace: 'nowrap',
              }}
            >
              Sign in
            </Link>
          </div>
        )}

        {/* ── Post ──────────────────────────────────────────────────────────
            On the page ground, closed by a rule — the prototype's
            `article{padding:var(--s5) 0;border-top:1px solid var(--rule)}`.
            The post used to sit in a filled, bordered, 14px-radius card
            inset 32px from a column that is already capped at the reading
            measure, so the body it contains was the one thing on screen
            being framed by chrome. */}
        <article
          style={{
            paddingBottom: 'var(--space-5)',
            marginBottom: 'var(--space-5)',
            borderBottom: '1px solid var(--border)',
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
              <div style={{ position: 'absolute', top: 0, right: 0 }}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label={t('a11y.postActions')}
                  aria-expanded={menuOpen}
                  // `.os-chip` supplies the 36px target and — the part an
                  // inline style cannot express — the focus ring. The open
                  // state is styled here rather than via `aria-pressed`:
                  // this is a menu button, and announcing it as both
                  // expanded AND pressed says the same thing twice.
                  className="os-chip"
                  style={{
                    fontSize: 'var(--text-body-lg)',
                    lineHeight: 1,
                    fontFamily: 'var(--font-mono)',
                    ...(menuOpen
                      ? { background: 'var(--color-bg-secondary)', borderColor: 'var(--color-border-default)' }
                      : null),
                  }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + var(--space-1))',
                      right: 0,
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-control)',
                      padding: 'var(--space-1)',
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
                          minHeight: 'var(--touch-target-min)',
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-text-primary)',
                          cursor: pinning ? 'not-allowed' : 'pointer',
                          padding: 'var(--space-2) var(--space-3)',
                          borderRadius: 'var(--radius-control)',
                          fontSize: 'var(--text-caption)',
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
                            minHeight: 'var(--touch-target-min)',
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            color: recorded ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                            cursor: recorded ? 'not-allowed' : 'pointer',
                            padding: 'var(--space-2) var(--space-3)',
                            borderRadius: 'var(--radius-control)',
                            fontSize: 'var(--text-caption)',
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
                            minHeight: 'var(--touch-target-min)',
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-status-danger)',
                            cursor: postDeleting ? 'not-allowed' : 'pointer',
                            padding: 'var(--space-2) var(--space-3)',
                            borderRadius: 'var(--radius-control)',
                            fontSize: 'var(--text-caption)',
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
            <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder={t('postCard.titlePlaceholder')}
                style={{
                  width: '100%',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-control)',
                  padding: 'var(--space-3) var(--space-4)',
                  color: 'var(--color-text-primary)',
                  // 16px floor — anything smaller zooms the page on iOS.
                  fontSize: 'var(--text-body)',
                  fontWeight: 600,
                  outline: 'none',
                  boxSizing: 'border-box',
                  minHeight: 'var(--touch-target-min)',
                  fontFamily: 'inherit',
                }}
              />
              <SNSEditor
                topicId={topicId}
                placeholder={t('postCard.bodyPlaceholder')}
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
                    <p style={{ fontSize: 'var(--text-label)', color: 'var(--muted)', fontFamily: 'var(--font-mono)', margin: 0 }}>
                      Poll options are frozen — votes already exist. Question and closing time can still be updated.
                    </p>
                  )}
                </>
              )}
              {!editPoll && (
                <button
                  type="button"
                  onClick={() => setEditPoll({ question: '', options: ['', ''], multipleChoice: false, closesAt: null })}
                  className="os-button"
                  style={{ alignSelf: 'flex-start' }}
                >
                  Add poll
                </button>
              )}
              {editError && (
                <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-status-danger)', margin: 0, fontFamily: 'var(--font-mono)' }}>{editError}</p>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={editSaving}
                  className="os-button"
                  style={{ cursor: editSaving ? 'not-allowed' : 'pointer' }}
                >
                  {t('postDetail.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={editSaving || !editTitle.trim()}
                  className="os-button os-button-primary"
                  style={{
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)', flexWrap: 'wrap' }}>
              {/* `.os-label` supplies the size (12px floor), weight and the
                  uppercase+tracking — gated to :lang(en), because uppercase
                  is a no-op on Hangul and tracking reads as broken kerning.
                  The old inline 11px uppercase did neither. */}
              <Link
                href={`/topics/${topicId}`}
                className="os-label"
                style={{
                  display: 'inline-block',
                  color: 'var(--accent)',
                  textDecoration: 'none',
                }}
              >
                {post.topicTitle}
              </Link>
              {post.isJoinedTopic && (
                <span
                  // ONE evidence-chip treatment: outline on transparent, the
                  // same as Badge's verified tone and the topic header's
                  // Joined pill. The 10px tinted variant this replaces was a
                  // third treatment for a claim already spoken twice.
                  className="os-label"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    color: 'var(--color-brand-accent)',
                    background: 'transparent',
                    border: '1px solid var(--color-brand-accent)',
                    borderRadius: 'var(--radius-control)',
                    padding: '1px 6px',
                    lineHeight: 1.2,
                  }}
                  aria-label={t('a11y.memberOfTopic')}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <span
              onClick={() => post.authorProfileImage && handleImageClick(post.authorProfileImage)}
              style={{ cursor: post.authorProfileImage ? 'pointer' : undefined, display: 'inline-flex' }}
            >
              <Avatar src={post.authorProfileImage} name={post.authorNickname || 'U'} size={32} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, margin: 0, fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                {post.authorNickname}
                {post.isAI && <Badge type="ai" />}
              </p>
              {/* Meta, so it sits BELOW the name in the scale — it was 15px
                  against the name's 14px, which read as the id being the
                  more important of the two. */}
              <p className="os-break-all" style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
                {truncateId(post.authorId, 6, 4)} · {formatDate(post.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>

          <h1
            style={{
              fontSize: 'var(--text-heading-lg)',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              margin: '0 0 var(--space-4)',
              lineHeight: 'var(--leading-tight)',
              paddingBottom: 'var(--space-4)',
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
                aria-label={t('a11y.pinnedPost')}
              >
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z" />
              </svg>
            )}
            {post.title}
          </h1>

          {post.tags && post.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginBottom: 'var(--space-4)' }}>
              {post.tags.map(tag => (
                <span
                  key={tag.slug}
                  style={{
                    background: 'var(--color-brand-primary-muted)',
                    color: 'var(--accent)',
                    border: '1px solid var(--color-border-default)',
                    borderRadius: 'var(--radius-control)',
                    padding: '1px 7px',
                    fontSize: 'var(--text-label)',
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
            marginTop: 'var(--space-5)',
            paddingTop: 'var(--space-4)',
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
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-3)',
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
              fontSize: 'var(--text-heading-sm)',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: '0 0 var(--space-4)',
            }}
          >
            {comments.length > 0
              ? `${comments.length} Comment${comments.length !== 1 ? 's' : ''}`
              : 'Comments'}
          </h2>

          {/* A comment is a row on the page ground closed by a rule, not a
              filled card — the same treatment the post above it now has.
              Stacking filled cards inside a filled card was two levels of
              chrome around one paragraph of text. */}
          {comments.length > 0 && (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: 'var(--space-4) 0',
                    borderTop: '1px solid var(--color-border-default)',
                  }}
                >
                  {comment.isDeleted ? (
                    <p style={{
                      margin: 0,
                      color: 'var(--color-text-tertiary)',
                      fontStyle: 'italic',
                      fontSize: 'var(--text-body-sm)',
                    }}>
                      {comment.deletedBy === 'admin' ? 'Deleted by admin' : 'Deleted comment'}
                    </p>
                  ) : (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'var(--space-2)',
                          marginBottom: 'var(--space-2)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          onClick={() => comment.authorProfileImage && handleImageClick(comment.authorProfileImage)}
                          style={{ cursor: comment.authorProfileImage ? 'pointer' : undefined, display: 'inline-flex' }}
                        >
                          <Avatar src={comment.authorProfileImage} name={comment.authorNickname || 'U'} size={26} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                              {comment.authorNickname}
                            </span>
                            {comment.isAI && <Badge type="ai" />}
                            {comment.badges && comment.badges.length > 0 && comment.badges.map((b, i) => (
                              <Badge key={i} type={b.type} label={b.label} domain={b.domain} country={b.country} />
                            ))}
                          </span>
                          <span className="os-break-all" style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', marginLeft: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>
                            {truncateId(comment.authorId ?? '', 6, 4)} · {formatDate(comment.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {!isGuest && currentUserId && comment.authorId === currentUserId && (
                          <button
                            type="button"
                            onClick={() => handleDeleteComment(comment.id)}
                            disabled={deletingCommentId === comment.id}
                            className="os-chip"
                            style={{
                              minWidth: 36,
                              padding: 0,
                              color: 'var(--muted)',
                              opacity: deletingCommentId === comment.id ? 0.5 : 1,
                              cursor: deletingCommentId === comment.id ? 'not-allowed' : 'pointer',
                              flexShrink: 0,
                            }}
                            title={t('a11y.deleteComment')}
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
                          fontSize: 'var(--text-body)',
                          color: 'var(--foreground)',
                          maxWidth: 'var(--read-max)',
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
                padding: 'var(--space-5)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-card)',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 var(--space-3)' }}>
                {t('postDetail.signInToComment')}
              </p>
              <Link href="/" className="os-button os-button-primary">
                Sign in
              </Link>
            </div>
          ) : (
            <form
              onSubmit={handleCommentSubmit}
              style={{
                padding: 'var(--space-5)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-card)',
              }}
            >
              <label
                htmlFor="comment"
                style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
              >
                {t('postDetail.writeComment')}
              </label>
              <textarea
                id="comment"
                value={commentContent}
                onChange={(e) => setCommentContent(e.target.value)}
                placeholder={t('postCard.commentPlaceholder')}
                rows={4}
                style={{
                  width: '100%',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-control)',
                  padding: 'var(--space-3) var(--space-4)',
                  color: 'var(--foreground)',
                  // 16px floor: below it, iOS Safari zooms the whole page
                  // when this textarea takes focus.
                  fontSize: 'var(--text-body)',
                  outline: 'none',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  marginBottom: 'var(--space-2)',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-brand-primary)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
              {commentError && (
                <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)', margin: '0 0 var(--space-2)', fontFamily: 'var(--font-mono)' }}>
                  {commentError}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!commentContent.trim() || submitting}
                  className={commentContent.trim() ? 'os-button os-button-primary' : 'os-button'}
                  style={{ cursor: commentContent.trim() ? 'pointer' : 'not-allowed' }}
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
