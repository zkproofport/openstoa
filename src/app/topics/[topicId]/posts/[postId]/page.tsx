'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import Avatar from '@/components/Avatar';
import SNSContent from '@/components/SNSContent';
import Spinner from '@/components/Spinner';
import ImageLightbox from '@/components/ImageLightbox';
import { HeartIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, TrashIcon } from '@/components/icons';
import { formatDate, truncateId } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Post {
  id: string;
  title: string;
  content: string;
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
}

interface Comment {
  id: string;
  content: string;
  authorNickname: string;
  authorProfileImage?: string | null;
  authorId: string;
  createdAt: string;
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

  const [userVote, setUserVote] = useState<number | null>(null);
  const [upvoteCount, setUpvoteCount] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [voteLoading, setVoteLoading] = useState(false);
  const [shared, setShared] = useState(false);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);

  // Guest mode
  const [isGuest, setIsGuest] = useState(false);

  function handleImageClick(src: string) {
    if (window.innerWidth <= 768 || 'ontouchstart' in window) {
      setLightboxSrc(src);
    } else {
      window.open(src, '_blank');
    }
  }

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) {
          setIsGuest(true);
        }
      })
      .catch(() => {
        setIsGuest(true);
      });
  }, []);

  useEffect(() => {
    loadPost();
    // Only check bookmark status for authenticated users
    fetch(`/api/posts/${postId}/bookmark`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBookmarked(data.bookmarked); })
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

  if (loading) {
    return (
      <>
        <Header />
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner />
        </div>
      </>
    );
  }

  if (error || !post) {
    return (
      <>
        <Header />
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14, marginBottom: 16 }}>
            {error ?? 'Post not found'}
          </p>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--accent)', fontSize: 14 }}>
            ← Back to topic
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
      <div style={{ paddingTop: 36, paddingBottom: 80, maxWidth: '56rem', margin: '0 auto', padding: '36px 1.5rem 80px' }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: 'var(--muted)' }}>
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
          }}
        >
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
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0, fontFamily: 'monospace' }}>
                {post.authorNickname}
              </p>
              <p style={{ fontSize: 15, color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'monospace' }}>
                {truncateId(post.authorId, 6, 4)} · {formatDate(post.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>

          {post.tags && post.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {post.tags.map(tag => (
                <span
                  key={tag.slug}
                  style={{
                    background: 'rgba(59,130,246,0.1)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(59,130,246,0.2)',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 14,
                    fontFamily: 'monospace',
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          <div ref={contentAreaRef}>
            <SNSContent html={post.content} />
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
          }}>
            {/* Like — disabled for guests */}
            {!isGuest ? (
              <button
                type="button"
                onClick={() => handleVote(1)}
                disabled={voteLoading}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: userVote === 1 ? '#ef4444' : 'var(--muted)',
                  fontSize: 14,
                  fontFamily: 'monospace',
                  padding: 0,
                  transition: 'color 0.15s',
                }}
              >
                <HeartIcon filled={userVote === 1} />
                {upvoteCount > 0 && upvoteCount}
              </button>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontFamily: 'monospace' }}>
                <HeartIcon filled={false} />
                {upvoteCount > 0 && upvoteCount}
              </span>
            )}

            {/* Comments */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontFamily: 'monospace' }}>
              <CommentIcon />
              {comments.length}
            </span>

            {/* Views */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontFamily: 'monospace' }}>
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
                fontFamily: 'monospace',
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
        </article>

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
                    padding: '16px 20px',
                    background: 'var(--surface, #0c0e18)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                  }}
                >
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
                    <div>
                      <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'monospace' }}>
                        {comment.authorNickname}
                      </span>
                      <span style={{ fontSize: 15, color: 'var(--muted)', marginLeft: 8, fontFamily: 'monospace' }}>
                        {truncateId(comment.authorId, 6, 4)} · {formatDate(comment.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
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
                <p style={{ fontSize: 14, color: '#ef4444', margin: '0 0 8px', fontFamily: 'monospace' }}>
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
      </div>
    </>
  );
}
