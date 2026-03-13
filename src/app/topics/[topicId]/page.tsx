'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import SNSEditor from '@/components/SNSEditor';
import TagInput from '@/components/TagInput';
import PostCard from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import TopicAvatar from '@/components/TopicAvatar';
import ImageLightbox from '@/components/ImageLightbox';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Topic {
  id: string;
  title: string;
  description?: string;
  image?: string;
  memberCount: number;
  requiresCountryProof: boolean;
  isMember: boolean;
  creatorId?: string;
  createdAt: string;
}

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface Reaction {
  emoji: string;
  count: number;
  userReacted: boolean;
}

interface Post {
  id: string;
  title: string;
  content: string;
  media?: { embeds?: Embed[] } | null;
  authorNickname: string;
  authorProfileImage?: string | null;
  authorId: string;
  commentCount?: number;
  upvoteCount?: number;
  viewCount?: number;
  isPinned?: boolean;
  reactions?: Reaction[];
  userVoted?: number | null;
  createdAt: string;
}

const PAGE_SIZE = 20;

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
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

  // Sort
  const [sortBy, setSortBy] = useState<'new' | 'popular'>('new');

  // Tag filter
  const [popularTags, setPopularTags] = useState<{ id: string; name: string; slug: string; postCount: number }[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Tag search
  const [tagSearch, setTagSearch] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<{ slug: string; name: string; postCount: number }[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const tagSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagSearchRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Composer
  const [composing, setComposing] = useState(false);
  const [postTitle, setPostTitle] = useState('');
  const [postContentHtml, setPostContentHtml] = useState('');
  const [postMedia, setPostMedia] = useState<{ embeds: Embed[] }>({ embeds: [] });
  const [postTags, setPostTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

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
      .then((data) => { if (data?.userId) setSessionUserId(data.userId); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTopic();
    loadPosts(0, true, null, 'new');
    fetch(`/api/tags?topicId=${topicId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.tags) setPopularTags(data.tags); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  // Close tag suggestions on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (tagSearchRef.current && !tagSearchRef.current.contains(e.target as Node)) {
        setShowTagSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadTopic() {
    try {
      const res = await fetch(`/api/topics/${topicId}`);
      if (res.status === 401) { router.replace('/'); return; }
      if (res.status === 403) { router.replace(`/topics/${topicId}/join`); return; }
      if (!res.ok) throw new Error('Topic not found');
      const data = await res.json();
      setTopic(data.topic);
      if (data.currentUserRole) setCurrentUserRole(data.currentUserRole);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topic');
    } finally {
      setLoading(false);
    }
  }

  const loadPosts = useCallback(async (currentOffset: number, replace: boolean, tag: string | null, currentSort: string) => {
    setPostsLoading(true);
    try {
      const tagParam = tag ? `&tag=${encodeURIComponent(tag)}` : '';
      const res = await fetch(
        `/api/topics/${topicId}/posts?limit=${PAGE_SIZE}&offset=${currentOffset}&sort=${currentSort}${tagParam}`
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

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !postsLoading) {
          loadPosts(offset, false, activeTag, sortBy);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, postsLoading, offset, activeTag, sortBy, loadPosts]);

  function handleLoadMore() {
    loadPosts(offset, false, activeTag, sortBy);
  }

  function handleTagSelect(slug: string | null) {
    setActiveTag(slug);
    setTagSearch('');
    setTagSuggestions([]);
    setShowTagSuggestions(false);
    setOffset(0);
    loadPosts(0, true, slug, sortBy);
  }

  function handleSortChange(newSort: 'new' | 'popular') {
    if (newSort === sortBy) return;
    setSortBy(newSort);
    setOffset(0);
    loadPosts(0, true, activeTag, newSort);
  }

  function handleTagSearchChange(value: string) {
    setTagSearch(value);
    if (tagSearchTimer.current) clearTimeout(tagSearchTimer.current);
    if (!value.trim()) {
      setTagSuggestions([]);
      setShowTagSuggestions(false);
      return;
    }
    tagSearchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tags?topicId=${topicId}&q=${encodeURIComponent(value.trim())}`);
        if (!res.ok) return;
        const data = await res.json();
        setTagSuggestions(data.tags ?? []);
        setShowTagSuggestions(true);
      } catch {}
    }, 300);
  }

  function handlePinPost(postId: string) {
    // Reload posts to reflect pin state change
    loadPosts(0, true, activeTag, sortBy);
  }

  async function handleCopyInvite() {
    const url = `${window.location.origin}/topics/${topicId}/join`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for mobile browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
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
      try { localStorage.removeItem('zk-community-draft'); } catch {}
      setComposing(false);
      loadPosts(0, true, activeTag, sortBy);
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
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
      <div style={{ paddingTop: 36, paddingBottom: 100, position: 'relative', maxWidth: '56rem', margin: '0 auto', padding: '36px 1.5rem 100px' }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24 }}>
          <Link href="/topics" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            ← Topics
          </Link>
        </div>

        {/* Topic header — full width within max-w-4xl */}
        <div style={{
          padding: '20px 24px',
          background: 'var(--surface, #0c0e18)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 14,
          marginBottom: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}>
          <TopicAvatar
            name={topic.title}
            image={topic.image}
            size={48}
            onClick={topic.image ? () => handleImageClick(topic.image!) : undefined}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', margin: 0, color: '#e5e7eb' }}>
                {topic.title}
              </h1>
              {topic.requiresCountryProof && (
                <span style={{
                  fontSize: 15,
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
              <p style={{ fontSize: 15, color: '#6b7280', margin: '4px 0 0', lineHeight: 1.5 }}>
                {topic.description}
              </p>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <Link
                href={`/topics/${topicId}/members`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 14,
                  color: '#6b7280',
                  fontFamily: 'monospace',
                  textDecoration: 'none',
                  transition: 'color 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--accent)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#6b7280'; }}
              >
                {topic.memberCount} member{topic.memberCount !== 1 ? 's' : ''}
              </Link>
              {(currentUserRole === 'owner' || currentUserRole === 'admin') && (
                <Link
                  href={`/topics/${topicId}/members`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 15,
                    fontWeight: 600,
                    color: '#9ca3af',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6,
                    padding: '3px 10px',
                    textDecoration: 'none',
                    transition: 'all 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--accent)';
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,130,246,0.3)';
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.08)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = '#9ca3af';
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.1)';
                    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  Manage
                </Link>
              )}
            </div>
          </div>
          <button
            onClick={handleCopyInvite}
            style={{
              background: copied ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
              color: copied ? '#22c55e' : '#6b7280',
              border: `1px solid ${copied ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 7,
              padding: '8px 14px',
              fontSize: 15,
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

        {/* ── Tag search + filter bar ── */}
        <div style={{ maxWidth: 600, margin: '0 auto 12px' }}>
          {/* Tag search input */}
          <div ref={tagSearchRef} style={{ position: 'relative', marginBottom: 10 }}>
            <input
              type="text"
              placeholder="Search tags..."
              value={tagSearch}
              onChange={(e) => handleTagSearchChange(e.target.value)}
              onFocus={() => { if (tagSuggestions.length > 0) setShowTagSuggestions(true); }}
              style={{
                width: '100%',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: '8px 14px',
                color: '#e5e7eb',
                fontSize: 15,
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.12s',
              }}
            />
            {showTagSuggestions && tagSuggestions.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: 4,
                background: 'var(--surface, #0c0e18)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                overflow: 'hidden',
                zIndex: 20,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              }}>
                {tagSuggestions.map((tag) => (
                  <button
                    key={tag.slug}
                    onClick={() => handleTagSelect(tag.slug)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      padding: '8px 14px',
                      color: '#e5e7eb',
                      fontSize: 15,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                  >
                    <span>#{tag.name}</span>
                    <span style={{ fontSize: 15, color: '#6b7280', fontFamily: 'monospace' }}>{tag.postCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Popular tag buttons */}
          {popularTags.length > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <button
                onClick={() => handleTagSelect(null)}
                style={{
                  background: activeTag === null ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
                  color: activeTag === null ? '#fff' : '#9ca3af',
                  border: activeTag === null ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 9999,
                  padding: '4px 12px',
                  fontSize: 14,
                  fontWeight: activeTag === null ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.12s',
                }}
              >
                All
              </button>
              {popularTags.slice(0, 8).map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => handleTagSelect(tag.slug)}
                  style={{
                    background: activeTag === tag.slug ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
                    color: activeTag === tag.slug ? 'var(--accent)' : '#9ca3af',
                    border: activeTag === tag.slug
                      ? '1px solid rgba(59,130,246,0.3)'
                      : '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 9999,
                    padding: '4px 12px',
                    fontSize: 14,
                    fontWeight: activeTag === tag.slug ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                  }}
                >
                  #{tag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Sort pills ── */}
        <div style={{
          maxWidth: 600,
          margin: '0 auto 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <button
            onClick={() => handleSortChange('new')}
            style={{
              background: sortBy === 'new' ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
              color: sortBy === 'new' ? '#fff' : '#9ca3af',
              border: sortBy === 'new' ? 'none' : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 9999,
              padding: '4px 14px',
              fontSize: 14,
              fontWeight: sortBy === 'new' ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 0.12s',
            }}
          >
            🆕 New
          </button>
          <button
            onClick={() => handleSortChange('popular')}
            style={{
              background: sortBy === 'popular' ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
              color: sortBy === 'popular' ? '#fff' : '#9ca3af',
              border: sortBy === 'popular' ? 'none' : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 9999,
              padding: '4px 14px',
              fontSize: 14,
              fontWeight: sortBy === 'popular' ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 0.12s',
            }}
          >
            🔥 Popular
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
              background: 'var(--surface, #0c0e18)',
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
                      background: 'var(--surface, #0c0e18)',
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
                    <TagInput tags={postTags} onChange={setPostTags} topicId={topicId} />
                  </div>
                  {postError && (
                    <p style={{ fontSize: 14, color: '#ef4444', margin: 0, fontFamily: 'monospace' }}>
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
                        try { localStorage.removeItem('zk-community-draft'); } catch {}
                      }}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: '#6b7280',
                        border: 'none',
                        borderRadius: 6,
                        padding: '8px 16px',
                        fontSize: 15,
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
                        fontSize: 15,
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
                <PostCard
                  key={post.id}
                  post={post}
                  href={`/topics/${topicId}/posts/${post.id}`}
                  showAuthor
                  media={post.media}
                  isPinned={post.isPinned}
                  userVoted={post.userVoted}
                  reactions={post.reactions}
                  sessionUserId={sessionUserId}
                  authorId={post.authorId}
                  topicCreatorId={topic?.creatorId}
                  onDelete={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
                  onPin={handlePinPost}
                  expandable
                />
              ))
            )}
          </div>

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
              {postsLoading && <Spinner />}
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

