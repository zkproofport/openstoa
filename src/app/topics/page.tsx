'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import PostCard, { PostCardPost } from '@/components/PostCard';
import Spinner from '@/components/Spinner';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeedPost extends PostCardPost {
  topicId: string;
  topicTitle: string;
}

// ─── Inner Component ─────────────────────────────────────────────────────────

function TopicsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'top'>('hot');
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [activeCategory, setActiveCategory] = useState<string | null>(
    searchParams.get('category'),
  );
  const [activeTag, setActiveTag] = useState<string | null>(
    searchParams.get('tag'),
  );
  const observerRef = useRef<HTMLDivElement | null>(null);
  const LIMIT = 20;

  // ── Auth check ──
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) {
          setIsGuest(true);
          setSessionChecked(true);
          return;
        }
        if (!data.nickname) {
          router.replace('/profile');
          return;
        }
        setSessionUserId(data.userId);
        setSessionChecked(true);
      })
      .catch(() => {
        setIsGuest(true);
        setSessionChecked(true);
      });
  }, [router]);

  // ── Fetch feed ──
  const loadFeed = useCallback(async (sort: string, category: string | null, tag: string | null, currentOffset: number, append: boolean) => {
    if (!append) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      // Build feed URL
      let url = `/api/feed?sort=${sort}&limit=${LIMIT}&offset=${currentOffset}`;
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }
      if (tag) {
        url += `&tag=${encodeURIComponent(tag)}`;
      }

      const res = await fetch(url);

      if (!res.ok) {
        // If feed endpoint doesn't exist yet (404), show empty state
        if (res.status === 404) {
          if (!append) setPosts([]);
          setHasMore(false);
          return;
        }
        throw new Error('Failed to load feed');
      }

      const data = await res.json();
      const newPosts: FeedPost[] = (data.posts ?? []).map((p: FeedPost) => ({
        ...p,
        topicTitle: p.topicTitle ?? '',
        topicId: p.topicId ?? '',
      }));

      if (append) {
        setPosts((prev) => [...prev, ...newPosts]);
      } else {
        setPosts(newPosts);
      }

      setHasMore(newPosts.length >= LIMIT);
      setOffset(currentOffset + newPosts.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // ── Initial load & filter changes ──
  useEffect(() => {
    if (sessionChecked) {
      setOffset(0);
      setHasMore(true);
      loadFeed(sortBy, activeCategory, activeTag, 0, false);
    }
  }, [sortBy, activeCategory, activeTag, sessionChecked, loadFeed]);

  // ── Infinite scroll ──
  useEffect(() => {
    if (!observerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          loadFeed(sortBy, activeCategory, activeTag, offset, true);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(observerRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, offset, sortBy, activeCategory, activeTag, loadFeed]);

  // ── Handlers ──
  function handleCategorySelect(slug: string | null) {
    setActiveCategory(slug);
    setActiveTag(null); // Reset tag when category changes
  }

  function handleTagSelect(slug: string | null) {
    setActiveTag(slug);
  }

  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
      activeCategory={activeCategory}
      onCategorySelect={handleCategorySelect}
      onTagSelect={handleTagSelect}
      activeTag={activeTag}
    >
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
          <span>You're browsing as a guest. Sign in to join topics and post.</span>
          <Link
            href="/"
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 13,
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Sign in
          </Link>
        </div>
      )}

      {/* Page heading */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 20,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              margin: 0,
              fontFamily: 'var(--font-serif)',
            }}
          >
            Feed
          </h1>
          {(activeCategory || activeTag) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              {activeCategory && (
                <span style={{ fontSize: 13, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  Category: <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{activeCategory}</span>
                </span>
              )}
              {activeTag && (
                <span style={{ fontSize: 13, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  Tag: <span style={{ color: 'var(--accent)', fontWeight: 600 }}>#{activeTag}</span>
                </span>
              )}
              <button
                onClick={() => {
                  setActiveCategory(null);
                  setActiveTag(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '2px 6px',
                  borderRadius: 4,
                  transition: 'color 0.12s',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.02em',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--foreground)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sort pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {(
          [
            { key: 'hot', label: 'Hot' },
            { key: 'new', label: 'New' },
            { key: 'top', label: 'Top' },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            style={{
              background: sortBy === key ? 'var(--accent)' : 'transparent',
              color: sortBy === key ? '#fff' : 'var(--muted)',
              border: `1px solid ${sortBy === key ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 20,
              padding: '4px 14px',
              fontSize: 13,
              fontWeight: sortBy === key ? 600 : 400,
              cursor: 'pointer',
              letterSpacing: '0.02em',
              transition: 'all 0.15s',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '60px 0',
          }}
        >
          <Spinner />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '16px 20px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 10,
            fontSize: 14,
            color: '#ef4444',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && posts.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '80px 20px',
            border: '1px dashed var(--border)',
            borderRadius: 16,
          }}
        >
          <p
            style={{
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: 8,
            }}
          >
            {activeCategory || activeTag ? 'No posts match these filters' : 'No posts yet'}
          </p>
          <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 24 }}>
            {activeCategory || activeTag
              ? 'Try selecting a different category or tag.'
              : 'Be the first to start a discussion.'}
          </p>
          {(activeCategory || activeTag) && (
            <button
              onClick={() => {
                setActiveCategory(null);
                setActiveTag(null);
              }}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '10px 24px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Posts feed */}
      {!loading && !error && posts.length > 0 && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              href={`/topics/${post.topicId}/posts/${post.id}`}
              showAuthor
              showTopic
              sessionUserId={sessionUserId}
              expandable
            />
          ))}
        </div>
      )}

      {/* Load more / infinite scroll sentinel */}
      {hasMore && !loading && posts.length > 0 && (
        <div
          ref={observerRef}
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '24px 0',
          }}
        >
          {loadingMore && <Spinner size={20} />}
        </div>
      )}
    </CommunityLayout>
  );
}

// ─── Page Export ──────────────────────────────────────────────────────────────

export default function TopicsPage() {
  return (
    <Suspense>
      <TopicsPageInner />
    </Suspense>
  );
}
