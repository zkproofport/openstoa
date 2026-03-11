'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import SNSContent from '@/components/SNSContent';

interface Post {
  id: string;
  title: string;
  content: string;
  media?: { embeds?: { type: 'youtube' | 'vimeo'; url: string; videoId: string }[] } | null;
  authorNickname: string;
  authorId: string;
  createdAt: string;
  topicId: string;
  topicTitle?: string;
  upvoteCount: number;
  viewCount: number;
  commentCount: number;
  tags?: { name: string; slug: string }[];
}

interface Comment {
  id: string;
  content: string;
  authorNickname: string;
  authorId: string;
  createdAt: string;
}

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

  useEffect(() => {
    loadPost();
    fetch(`/api/posts/${postId}/bookmark`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setBookmarked(data.bookmarked); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  async function loadPost() {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      if (res.status === 401) { router.replace('/'); return; }
      if (res.status === 403) { router.replace(`/topics/${topicId}/join`); return; }
      if (!res.ok) throw new Error('Post not found');
      const data = await res.json();
      setPost(data.post);
      setComments(data.comments ?? []);
      setUpvoteCount(data.post.upvoteCount ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load post');
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(value: 1 | -1) {
    if (voteLoading) return;
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
    if (!commentContent.trim()) return;
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

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncateId(id: string) {
    return `${id.slice(0, 6)}...${id.slice(-4)}`;
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
      <div style={{ paddingTop: 36, paddingBottom: 80 }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)' }}>
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

        {/* Post */}
        <article
          style={{
            padding: '28px 32px',
            background: '#0d0d0d',
            border: '1px solid var(--border)',
            borderRadius: 14,
            marginBottom: 32,
          }}
        >
          <h1
            style={{
              fontSize: 24,
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
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {post.authorNickname.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0, fontFamily: 'monospace' }}>
                {post.authorNickname}
              </p>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0', fontFamily: 'monospace' }}>
                {truncateId(post.authorId)} · {formatDate(post.createdAt)}
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
                    fontSize: 12,
                    fontFamily: 'monospace',
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          <SNSContent html={post.content} media={post.media} />

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
          }}>
            {/* Vote buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => handleVote(1)}
                disabled={voteLoading}
                style={{
                  background: userVote === 1 ? 'rgba(34,197,94,0.15)' : 'transparent',
                  color: userVote === 1 ? '#22c55e' : 'var(--muted)',
                  border: `1px solid ${userVote === 1 ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                  transition: 'all 0.15s',
                }}
              >
                ↑
              </button>
              <span style={{
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'monospace',
                color: upvoteCount > 0 ? '#22c55e' : upvoteCount < 0 ? '#ef4444' : 'var(--muted)',
                minWidth: 28,
                textAlign: 'center',
              }}>
                {upvoteCount}
              </span>
              <button
                type="button"
                onClick={() => handleVote(-1)}
                disabled={voteLoading}
                style={{
                  background: userVote === -1 ? 'rgba(239,68,68,0.15)' : 'transparent',
                  color: userVote === -1 ? '#ef4444' : 'var(--muted)',
                  border: `1px solid ${userVote === -1 ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                  transition: 'all 0.15s',
                }}
              >
                ↓
              </button>
            </div>

            {/* View count */}
            <span style={{ fontSize: 13, color: 'var(--muted)', fontFamily: 'monospace' }}>
              {post.viewCount} views
            </span>

            {/* Share button */}
            <button
              type="button"
              onClick={handleShare}
              style={{
                background: shared ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: shared ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${shared ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                transition: 'all 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
              {shared ? 'Copied!' : 'Share'}
            </button>

            {/* Bookmark button */}
            <button
              type="button"
              onClick={handleBookmark}
              style={{
                marginLeft: 'auto',
                background: bookmarked ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: bookmarked ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${bookmarked ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                transition: 'all 0.15s',
              }}
            >
              {bookmarked ? '★ Saved' : '☆ Save'}
            </button>
          </div>
        </article>

        {/* Comments section */}
        <div>
          <h2
            style={{
              fontSize: 16,
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
                    background: '#0d0d0d',
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
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: '50%',
                        background: '#262626',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--muted)',
                        flexShrink: 0,
                      }}
                    >
                      {comment.authorNickname.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'monospace' }}>
                        {comment.authorNickname}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8, fontFamily: 'monospace' }}>
                        {truncateId(comment.authorId)} · {formatDate(comment.createdAt)}
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

          {/* Comment form */}
          <form
            onSubmit={handleCommentSubmit}
            style={{
              padding: '20px',
              background: '#0d0d0d',
              border: '1px solid var(--border)',
              borderRadius: 12,
            }}
          >
            <label
              htmlFor="comment"
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
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
                background: '#111',
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
              <p style={{ fontSize: 12, color: '#ef4444', margin: '0 0 8px', fontFamily: 'monospace' }}>
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
        </div>
      </div>
    </>
  );
}

function Spinner() {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
