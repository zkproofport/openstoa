'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import SNSEditor from '@/components/SNSEditor';
import SNSContent from '@/components/SNSContent';
import TagInput from '@/components/TagInput';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Topic {
  id: string;
  title: string;
  description?: string;
  image?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  isMember: boolean;
  createdAt: string;
}

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface Post {
  id: string;
  title: string;
  content: string;
  media?: { embeds?: Embed[] } | null;
  authorNickname: string;
  commentCount?: number;
  upvoteCount?: number;
  viewCount?: number;
  createdAt: string;
}

const PAGE_SIZE = 20;

// ─── Relative Time ──────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function HeartIcon({ filled }: { filled?: boolean }) {
  if (filled) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#ef4444" stroke="none">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12h6" />
      <path d="M12 9l3 3-3 3" />
      <path d="M19 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
    </svg>
  );
}

function BookmarkIcon({ filled }: { filled?: boolean }) {
  if (filled) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ─── Topic Avatar ───────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#06b6d4', '#eab308'];

function TopicAvatar({ title, image, size = 40 }: { title: string; image?: string; size?: number }) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }
  const colorIndex = title.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: AVATAR_COLORS[colorIndex],
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.45,
      fontWeight: 700,
      color: '#fff',
      flexShrink: 0,
    }}>
      {title.slice(0, 1).toUpperCase()}
    </div>
  );
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

// ─── Post Card ──────────────────────────────────────────────────────────────

function PostCard({
  post,
  topic,
  topicId,
}: {
  post: Post;
  topic: Topic;
  topicId: string;
}) {
  const [shareText, setShareText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const handleShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}/topics/${topicId}/posts/${post.id}`;
    if (navigator.share) {
      try { await navigator.share({ title: post.title, url }); return; } catch {}
    }
    await navigator.clipboard.writeText(url);
    setShareText('Copied!');
    setTimeout(() => setShareText(null), 1500);
  };

  const handleToggleExpand = useCallback(() => {
    setExpanded(true);
  }, []);

  return (
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
      {/* Clicking on the card body navigates; action buttons stop propagation */}
      <Link
        href={`/topics/${topicId}/posts/${post.id}`}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        {/* Header: avatar + topic name + time + author */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <TopicAvatar title={topic.title} image={topic.image} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>
                {topic.title}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 1 }}>
              {relativeTime(post.createdAt)} · {post.authorNickname}
            </div>
          </div>
        </div>

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

        {/* Body preview */}
        <div>
          <SNSContent
            html={post.content}
            media={post.media}
            truncate={!expanded}
            maxLines={3}
            onToggleExpand={handleToggleExpand}
          />
        </div>
      </Link>

      {/* Action bar — outside Link to allow independent clicks */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        marginTop: 10,
      }}>
        {/* Like */}
        <ActionButton
          icon={<HeartIcon filled={(post.upvoteCount ?? 0) > 0} />}
          count={post.upvoteCount ?? 0}
          color="#ef4444"
          active={(post.upvoteCount ?? 0) > 0}
        />

        {/* Comment */}
        <ActionButton
          icon={<CommentIcon />}
          count={post.commentCount ?? 0}
        />

        {/* Share */}
        <ActionButton
          icon={<ShareIcon />}
          label={shareText ?? undefined}
          color="var(--accent)"
          active={!!shareText}
          onClick={handleShare}
        />

        <div style={{ flex: 1 }} />

        {/* Bookmark placeholder */}
        <ActionButton
          icon={<BookmarkIcon />}
        />
      </div>
    </article>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

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

  // Composer
  const [composing, setComposing] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postContentHtml, setPostContentHtml] = useState('');
  const [postMedia, setPostMedia] = useState<{ embeds: Embed[] }>({ embeds: [] });
  const [postTags, setPostTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

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

  function isHtmlEmpty(html: string): boolean {
    const stripped = html
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<p><br><\/p>/gi, '')
      .replace(/<div><br><\/div>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim();
    return stripped.length === 0;
  }

  async function handlePostSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!postTitle.trim() || isHtmlEmpty(postContentHtml)) return;
    setSubmitting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: postTitle.trim(),
          content: postContentHtml,
          media: postMedia.embeds.length > 0 ? { embeds: postMedia.embeds } : undefined,
          tags: postTags.length > 0 ? postTags : undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to post');
      }
      setPostTitle('');
      setPostContentHtml('');
      setPostMedia({ embeds: [] });
      setPostTags([]);
      setComposing(false);
      loadPosts(0, true);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Unknown error');
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
      <div style={{ paddingTop: 36, paddingBottom: 100, position: 'relative' }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24 }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            ← Topics
          </Link>
        </div>

        {/* Topic header — full width within max-w-4xl */}
        <div style={{
          padding: '20px 24px',
          background: '#0d0d0d',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 14,
          marginBottom: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}>
          <TopicAvatar title={topic.title} image={topic.image} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.03em', margin: 0, color: '#e5e7eb' }}>
                {topic.title}
              </h1>
              {topic.requiresCountryProof && (
                <span style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  background: 'rgba(59,130,246,0.12)',
                  color: 'var(--accent)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  padding: '2px 7px',
                  borderRadius: 4,
                }}>
                  country gated
                </span>
              )}
            </div>
            {topic.description && (
              <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0', lineHeight: 1.5 }}>
                {topic.description}
              </p>
            )}
            <p style={{ fontSize: 12, color: '#4b5563', margin: '6px 0 0', fontFamily: 'monospace' }}>
              {topic.memberCount} member{topic.memberCount !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={handleCopyInvite}
            style={{
              background: copied ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
              color: copied ? '#22c55e' : '#6b7280',
              border: `1px solid ${copied ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
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
            {copied ? 'Copied!' : 'Invite'}
          </button>
        </div>

        {/* ── Centered feed column (~600px) ── */}
        <div style={{
          maxWidth: 600,
          margin: '0 auto',
        }}>
          {/* Composer (expanded) */}
          {composing && (
            <div style={{
              background: '#0d0d0d',
              border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: 12,
              padding: '20px',
              marginBottom: 8,
            }}>
              <form onSubmit={handlePostSubmit}>
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 16px', letterSpacing: '-0.02em', color: '#e5e7eb' }}>
                  New Post
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <input
                    type="text"
                    value={postTitle}
                    onChange={(e) => setPostTitle(e.target.value)}
                    placeholder="Post title"
                    autoFocus
                    style={{
                      width: '100%',
                      background: '#111',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 7,
                      padding: '10px 14px',
                      color: '#e5e7eb',
                      fontSize: 14,
                      fontWeight: 600,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <SNSEditor
                    placeholder="Write your post..."
                    onChange={(html, media) => {
                      setPostContentHtml(html);
                      setPostMedia(media);
                    }}
                    minHeight={180}
                  />
                  <div style={{ marginTop: 4 }}>
                    <TagInput tags={postTags} onChange={setPostTags} />
                  </div>
                  {postError && (
                    <p style={{ fontSize: 12, color: '#ef4444', margin: 0, fontFamily: 'monospace' }}>
                      {postError}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setComposing(false);
                        setPostTitle('');
                        setPostContentHtml('');
                        setPostMedia({ embeds: [] });
                        setPostTags([]);
                      }}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: '#6b7280',
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
                      disabled={!postTitle.trim() || isHtmlEmpty(postContentHtml) || submitting}
                      style={{
                        background: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '8px 20px',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        opacity: (!postTitle.trim() || isHtmlEmpty(postContentHtml) || submitting) ? 0.5 : 1,
                      }}
                    >
                      {submitting ? 'Posting...' : 'Post'}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* Feed border container */}
          <div style={{
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14,
            overflow: 'hidden',
          }}>
            {posts.length === 0 && !postsLoading ? (
              <div style={{
                textAlign: 'center',
                padding: '60px 20px',
              }}>
                <p style={{ fontSize: 15, color: '#6b7280' }}>
                  No posts yet. Be the first to write!
                </p>
              </div>
            ) : (
              posts.map((post) => (
                <PostCard key={post.id} post={post} topic={topic} topicId={topicId} />
              ))
            )}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button
                onClick={handleLoadMore}
                disabled={postsLoading}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: '#6b7280',
                  border: '1px solid rgba(255,255,255,0.08)',
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
        {/* ── End centered feed ── */}

        {/* Floating compose button */}
        {!composing && (
          <button
            onClick={() => setComposing(true)}
            style={{
              position: 'fixed',
              bottom: 32,
              right: 32,
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 24px rgba(59,130,246,0.3)',
              transition: 'transform 0.15s, box-shadow 0.15s',
              zIndex: 50,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.08)';
              e.currentTarget.style.boxShadow = '0 6px 32px rgba(59,130,246,0.4)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 4px 24px rgba(59,130,246,0.3)';
            }}
            title="Write Post"
          >
            <PlusIcon />
          </button>
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
