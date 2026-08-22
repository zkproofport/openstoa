'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import PostCard, { PostCardPost } from '@/components/PostCard';
import Spinner from '@/components/Spinner';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// ─── Types ───────────────────────────────────────────────────────────────────

type SortKey = 'hot' | 'new' | 'active' | 'top';

interface FeedPost extends PostCardPost {
  topicId: string;
  topicTitle: string;
  /** Surfaced by `/api/feed` so PostCard renders the green "Joined" pill
   *  next to the topic chip (W03). Already declared optional on
   *  PostCardPost — kept here for documentation. */
  isJoinedTopic?: boolean;
}

// ─── Inner Component ─────────────────────────────────────────────────────────

function TopicsPageInner() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('hot');
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
  const [activeQuery, setActiveQuery] = useState<string | null>(
    searchParams.get('q'),
  );
  const [viewMode, setViewMode] = useState<'all' | 'my'>(
    searchParams.get('view') === 'my' ? 'my' : 'all',
  );

  // Sync local filter state with URL when the header search bar pushes
  // a new query (or any other affordance updates URL params).
  useEffect(() => {
    setActiveQuery(searchParams.get('q'));
    setActiveCategory(searchParams.get('category'));
    setActiveTag(searchParams.get('tag'));
  }, [searchParams]);
  const observerRef = useRef<HTMLDivElement | null>(null);
  const LIMIT = 20;

  // ── Auth check ──
  useEffect(() => {
    apiFetch('/api/auth/session')
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
  const loadFeed = useCallback(async (sort: string, category: string | null, tag: string | null, q: string | null, currentOffset: number, append: boolean) => {
    if (!append) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      // Build feed URL
      let url = `/api/feed?sort=${sort}&limit=${LIMIT}&offset=${currentOffset}`;
      if (viewMode === 'my') {
        url += '&view=my';
      }
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }
      if (tag) {
        url += `&tag=${encodeURIComponent(tag)}`;
      }
      if (q && q.trim()) {
        url += `&q=${encodeURIComponent(q.trim())}`;
      }

      const res = await apiFetch(url);

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
  }, [viewMode]);

  // ── Initial load & filter changes ──
  useEffect(() => {
    if (sessionChecked) {
      setOffset(0);
      setHasMore(true);
      loadFeed(sortBy, activeCategory, activeTag, activeQuery, 0, false);
    }
  }, [sortBy, activeCategory, activeTag, activeQuery, sessionChecked, loadFeed]);

  // ── Infinite scroll ──
  useEffect(() => {
    if (!observerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          loadFeed(sortBy, activeCategory, activeTag, activeQuery, offset, true);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(observerRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, offset, sortBy, activeCategory, activeTag, activeQuery, loadFeed]);

  // ── Handlers ──
  const clearFilters = useCallback(() => {
    setActiveCategory(null);
    setActiveTag(null);
  }, []);

  // Re-runs the same request the current filters describe. The error state had
  // no recovery at all before — a failed fetch left the user on a dead screen.
  const retry = useCallback(() => {
    setOffset(0);
    setHasMore(true);
    loadFeed(sortBy, activeCategory, activeTag, activeQuery, 0, false);
  }, [loadFeed, sortBy, activeCategory, activeTag, activeQuery]);

  function handleCategorySelect(slug: string | null) {
    setActiveCategory(slug);
    setActiveTag(null); // Reset tag when category changes
    setViewMode('all'); // Switch back to all when selecting a category
  }

  function handleViewChange(view: 'all' | 'my') {
    setViewMode(view);
    setActiveCategory(null);
    setActiveTag(null);
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
      viewMode={viewMode}
      onViewChange={handleViewChange}
    >
      {/* Guest banner */}
      {isGuest && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--color-brand-primary-muted)',
            border: '1px solid var(--color-border-default)',
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
          <span>{t('feedPage.guestBanner')}</span>
          <Link
            href="/"
            style={{
              color: 'var(--color-brand-primary)',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 'var(--text-body-sm)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('feedPage.signIn')}
          </Link>
        </div>
      )}

      {/* Page heading */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <h1
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            margin: 0,
          }}
        >
          {t('feedPage.title')}
        </h1>
        {(activeCategory || activeTag) && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              marginTop: 'var(--space-1)', flexWrap: 'wrap',
            }}
          >
            {activeCategory && (
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>
                {t('feedPage.filterCategory')}:{' '}
                <span style={{ color: 'var(--color-brand-primary)', fontWeight: 600 }}>{activeCategory}</span>
              </span>
            )}
            {activeTag && (
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-secondary)' }}>
                {t('feedPage.filterTag')}:{' '}
                <span style={{ color: 'var(--color-brand-primary)', fontWeight: 600 }}>#{activeTag}</span>
              </span>
            )}
            <button type="button" onClick={clearFilters} className="os-chip">
              {t('feedPage.clearFilters')}
            </button>
          </div>
        )}
      </div>

      {/* R09: feed-home chip strip — transparent background (no brand tint)
          so the feed reads as the global cross-topic stream. Distinct from
          the topic page which wraps chips in a brand-tinted strip. */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        {(
          [
            { key: 'hot', label: t('feedPage.sort.hot'), icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
            ) },
            { key: 'new', label: t('feedPage.sort.new'), icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ) },
            { key: 'active', label: t('feedPage.sort.active'), icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            ) },
            { key: 'top', label: t('feedPage.sort.top'), icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            ) },
          ] as { key: SortKey; label: string; icon: React.ReactNode }[]
        ).map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSortBy(key)}
            className="os-chip"
            aria-pressed={sortBy === key}
          >
            {icon}
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

      {/* Error state. Distinct from "empty" ON PURPOSE: a failed request used
          to render a bare red bar containing the raw exception message and no
          way forward, which reads to a user as "there is nothing here". */}
      {error && !loading && (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-7) var(--space-5)',
            border: '1px solid var(--color-status-danger)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--color-bg-secondary)',
          }}
          role="alert"
        >
          <p
            style={{
              fontSize: 'var(--text-body-lg)', fontWeight: 600,
              color: 'var(--color-status-danger)', margin: '0 0 var(--space-2)',
            }}
          >
            {t('feedPage.error.title')}
          </p>
          <p
            style={{
              fontSize: 'var(--text-body-sm)', color: 'var(--color-text-secondary)',
              margin: '0 0 var(--space-5)',
            }}
          >
            {t('feedPage.error.body')}
          </p>
          <button type="button" onClick={retry} className="os-button os-button-primary">
            {t('feedPage.error.retry')}
          </button>
        </div>
      )}

      {/* Empty state — two genuinely different situations, not one message with
          a ternary: "your filters excluded everything" is recoverable here,
          "nothing exists yet" points outward to discovery. */}
      {!loading && !error && posts.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-7) var(--space-5)',
            border: '1px dashed var(--color-border-default)',
            borderRadius: 'var(--radius-card)',
          }}
        >
          <p
            style={{
              fontSize: 'var(--text-body-lg)', fontWeight: 600,
              letterSpacing: '-0.02em', margin: '0 0 var(--space-2)',
            }}
          >
            {activeCategory || activeTag
              ? t('feedPage.empty.filteredTitle')
              : t('feedPage.empty.firstTitle')}
          </p>
          <p
            style={{
              fontSize: 'var(--text-body-sm)', color: 'var(--color-text-secondary)',
              margin: '0 0 var(--space-5)',
            }}
          >
            {activeCategory || activeTag
              ? t('feedPage.empty.filteredBody')
              : t('feedPage.empty.firstBody')}
          </p>
          {activeCategory || activeTag ? (
            <button type="button" onClick={clearFilters} className="os-button os-button-primary">
              {t('feedPage.clearFilters')}
            </button>
          ) : (
            <Link href="/topics/explore" className="os-button os-button-primary">
              {t('feedPage.empty.firstCta')}
            </Link>
          )}
        </div>
      )}

      {/* Posts feed. No container card and no hover fill: posts sit directly on
          the page ground separated by rules, so the feed reads as one continuous
          column rather than a box of boxes. */}
      {!loading && !error && posts.length > 0 && (
        <div>
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
