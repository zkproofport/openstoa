'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import SNSEditor from '@/components/SNSEditor';
import TagInput from '@/components/TagInput';

interface Topic {
  id: string;
  title: string;
  description?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  isMember: boolean;
  createdAt: string;
}

interface Post {
  id: string;
  title: string;
  authorNickname: string;
  commentCount?: number;
  upvoteCount?: number;
  viewCount?: number;
  createdAt: string;
}

const PAGE_SIZE = 20;

export default function TopicPage() {
  const params = useParams();
  const router = useRouter();
  const topicId = params.topicId as string;

  const [topic, setTopic] = useState<Topic | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [postsLoading, setPostsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Write post inline
  const [composing, setComposing] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postContent, setPostContent] = useState('');
  const [postMedia, setPostMedia] = useState<{ images: string[]; embeds: { type: 'youtube' | 'vimeo'; url: string; videoId: string }[] }>({ images: [], embeds: [] });
  const [postTags, setPostTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Clipboard feedback
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadTopic();
    loadPosts(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  async function loadTopic() {
    try {
      const res = await fetch(`/api/topics/${topicId}`);
      if (res.status === 401) { router.replace('/'); return; }
      if (res.status === 403) { router.replace(`/topics/${topicId}/join`); return; }
      if (!res.ok) throw new Error('Topic not found');
      const data = await res.json();
      setTopic(data.topic);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topic');
    } finally {
      setLoading(false);
    }
  }

  const loadPosts = useCallback(async (currentOffset: number, replace: boolean) => {
    setPostsLoading(true);
    try {
      const res = await fetch(
        `/api/topics/${topicId}/posts?limit=${PAGE_SIZE}&offset=${currentOffset}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const newPosts: Post[] = data.posts ?? [];
      setPosts((prev) => (replace ? newPosts : [...prev, ...newPosts]));
      setHasMore(newPosts.length === PAGE_SIZE);
      setOffset(currentOffset + newPosts.length);
    } finally {
      setPostsLoading(false);
    }
  }, [topicId]);

  function handleLoadMore() {
    loadPosts(offset, false);
  }

  async function handleCopyInvite() {
    const url = `${window.location.origin}/topics/${topicId}/join`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePostSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!postTitle.trim() || !postContent.trim()) return;
    setSubmitting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: postTitle.trim(),
          content: postContent.trim(),
          media: (postMedia.images.length > 0 || postMedia.embeds.length > 0) ? postMedia : undefined,
          tags: postTags.length > 0 ? postTags : undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to post');
      }
      setPostTitle('');
      setPostContent('');
      setPostMedia({ images: [], embeds: [] });
      setPostTags([]);
      setComposing(false);
      loadPosts(0, true);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
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

  if (error || !topic) {
    return (
      <>
        <Header />
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14 }}>
            {error ?? 'Topic not found'}
          </p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 14 }}>
            ← Back to topics
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
        <div style={{ marginBottom: 24 }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            ← Topics
          </Link>
        </div>

        {/* Topic header */}
        <div
          style={{
            padding: '24px 28px',
            background: '#0d0d0d',
            border: '1px solid var(--border)',
            borderRadius: 14,
            marginBottom: 28,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 6 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 }}>
                  {topic.title}
                </h1>
                {topic.requiresCountryProof && (
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'monospace',
                      background: 'rgba(59,130,246,0.12)',
                      color: 'var(--accent)',
                      border: '1px solid rgba(59,130,246,0.2)',
                      padding: '2px 7px',
                      borderRadius: 4,
                    }}
                  >
                    country gated
                  </span>
                )}
              </div>
              {topic.description && (
                <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
                  {topic.description}
                </p>
              )}
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 0', fontFamily: 'monospace' }}>
                {topic.memberCount} member{topic.memberCount !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={handleCopyInvite}
              style={{
                background: copied ? 'rgba(34,197,94,0.12)' : 'var(--border)',
                color: copied ? '#22c55e' : 'var(--muted)',
                border: `1px solid ${copied ? 'rgba(34,197,94,0.3)' : 'transparent'}`,
                borderRadius: 7,
                padding: '8px 14px',
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
                flexShrink: 0,
              }}
            >
              {copied ? '✓ Copied!' : 'Copy Invite Link'}
            </button>
          </div>
        </div>

        {/* Write post button / composer */}
        {!composing ? (
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => setComposing(true)}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '9px 20px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + Write Post
            </button>
          </div>
        ) : (
          <form
            onSubmit={handlePostSubmit}
            style={{
              background: '#0d0d0d',
              border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: 12,
              padding: '20px',
              marginBottom: 24,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 16px', letterSpacing: '-0.02em' }}>
              New Post
            </h3>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                value={postTitle}
                onChange={(e) => setPostTitle(e.target.value)}
                placeholder="Post title"
                autoFocus
                style={{
                  width: '100%',
                  background: '#111',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  padding: '10px 14px',
                  color: 'var(--foreground)',
                  fontSize: 14,
                  fontWeight: 600,
                  outline: 'none',
                }}
              />
              <SNSEditor
                placeholder="Write your post..."
                onChange={(text, media) => {
                  setPostContent(text);
                  setPostMedia(media);
                }}
                minHeight={180}
              />
              <div style={{ marginTop: 12 }}>
                <TagInput tags={postTags} onChange={setPostTags} />
              </div>
              {postError && (
                <p style={{ fontSize: 12, color: '#ef4444', margin: 0, fontFamily: 'monospace' }}>
                  {postError}
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setComposing(false); setPostTitle(''); setPostContent(''); setPostMedia({ images: [], embeds: [] }); setPostTags([]); }}
                  style={{
                    background: 'var(--border)',
                    color: 'var(--muted)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 16px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!postTitle.trim() || !postContent.trim() || submitting}
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 20px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: (!postTitle.trim() || !postContent.trim() || submitting) ? 0.5 : 1,
                  }}
                >
                  {submitting ? 'Posting...' : 'Post'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Posts list */}
        {posts.length === 0 && !postsLoading ? (
          <div
            style={{
              textAlign: 'center',
              padding: '60px 20px',
              border: '1px dashed var(--border)',
              borderRadius: 12,
            }}
          >
            <p style={{ fontSize: 15, color: 'var(--muted)' }}>
              No posts yet. Be the first to write!
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {posts.map((post) => (
              <Link
                key={post.id}
                href={`/topics/${topicId}/posts/${post.id}`}
                style={{ textDecoration: 'none' }}
              >
                <div
                  style={{
                    padding: '16px 20px',
                    background: '#0d0d0d',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    transition: 'border-color 0.12s, background 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.35)';
                    (e.currentTarget as HTMLDivElement).style.background = '#111';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
                    (e.currentTarget as HTMLDivElement).style.background = '#0d0d0d';
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        margin: 0,
                        letterSpacing: '-0.01em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {post.title}
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
                      <span style={{ fontFamily: 'monospace' }}>{post.authorNickname}</span>
                      {' · '}
                      {formatDate(post.createdAt)}
                    </p>
                    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                      {post.upvoteCount != null && post.upvoteCount !== 0 && (
                        <span style={{ fontSize: 11, color: post.upvoteCount > 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>
                          {post.upvoteCount > 0 ? '↑' : '↓'}{Math.abs(post.upvoteCount)}
                        </span>
                      )}
                      {post.viewCount != null && post.viewCount > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                          {post.viewCount} views
                        </span>
                      )}
                    </div>
                  </div>
                  {post.commentCount != null && (
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--muted)',
                        flexShrink: 0,
                        fontFamily: 'monospace',
                      }}
                    >
                      {post.commentCount} comment{post.commentCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}

        {hasMore && (
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <button
              onClick={handleLoadMore}
              disabled={postsLoading}
              style={{
                background: 'var(--border)',
                color: 'var(--muted)',
                border: 'none',
                borderRadius: 8,
                padding: '10px 28px',
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              {postsLoading ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
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
