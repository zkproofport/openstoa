'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import TopicAvatar from '@/components/TopicAvatar';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
}

interface Topic {
  id: string;
  title: string;
  description?: string | null;
  image?: string | null;
  memberCount: number;
  proofType: string;
  visibility: string;
  isMember: boolean;
  category?: { id: string; name: string; slug: string; icon: string } | null;
  createdAt: string;
}

// ─── Proof badge helper ──────────────────────────────────────────────────────

function proofBadgeLabel(proofType: string): string | null {
  switch (proofType) {
    case 'kyc': return 'KYC Required';
    case 'country': return 'Country Gated';
    case 'google_workspace': return 'Google Workspace';
    case 'microsoft_365': return 'Microsoft 365';
    case 'workspace': return 'Workspace';
    default: return null;
  }
}

// ─── Inner Component ─────────────────────────────────────────────────────────

function ExplorePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [topics, setTopics] = useState<Topic[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'active' | 'top'>(
    (searchParams.get('sort') as 'hot' | 'new' | 'active' | 'top') || 'hot',
  );
  const [categoryFilter, setCategoryFilter] = useState<string | null>(
    searchParams.get('category'),
  );
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [joiningTopicId, setJoiningTopicId] = useState<string | null>(null);

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
        setSessionChecked(true);
      })
      .catch(() => {
        setIsGuest(true);
        setSessionChecked(true);
      });
  }, [router]);

  // ── Fetch categories ──
  useEffect(() => {
    fetch('/api/categories')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.categories) {
          setCategories(data.categories);
        }
      })
      .catch(() => {});
  }, []);

  // ── Fetch topics ──
  const loadTopics = useCallback(async (sort: string, category: string | null) => {
    setLoading(true);
    setError(null);
    try {
      let url = `/api/topics?view=all&sort=${sort}`;
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load topics');
      const data = await res.json();
      setTopics(data.topics ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionChecked) {
      loadTopics(sortBy, categoryFilter);
    }
  }, [sortBy, categoryFilter, sessionChecked, loadTopics]);

  // ── Join handler ──
  async function handleJoin(topicId: string) {
    if (isGuest) {
      router.push('/');
      return;
    }
    setJoiningTopicId(topicId);
    try {
      const res = await fetch(`/api/topics/${topicId}/join`, { method: 'POST' });
      if (res.ok) {
        setTopics((prev) =>
          prev.map((t) => (t.id === topicId ? { ...t, isMember: true, memberCount: t.memberCount + 1 } : t)),
        );
      }
    } catch {
      // silently fail
    } finally {
      setJoiningTopicId(null);
    }
  }

  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
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
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: 0,
            fontFamily: 'var(--font-serif)',
          }}
        >
          Explore Topics
        </h1>
      </div>

      {/* Sort pills + Category filter */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          {(
            [
              { key: 'hot', label: 'Hot' },
              { key: 'new', label: 'New' },
              { key: 'active', label: 'Active' },
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

        {/* Category filter */}
        {categories.length > 0 && (
          <select
            value={categoryFilter ?? ''}
            onChange={(e) => setCategoryFilter(e.target.value || null)}
            style={{
              background: 'var(--surface)',
              color: 'var(--foreground)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '5px 10px',
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.slug}>
                {cat.icon} {cat.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
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
      {!loading && !error && topics.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '80px 20px',
            border: '1px dashed var(--border)',
            borderRadius: 16,
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 8 }}>
            No topics found
          </p>
          <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 24 }}>
            {categoryFilter ? 'Try selecting a different category.' : 'Be the first to create a topic.'}
          </p>
          {categoryFilter && (
            <button
              onClick={() => setCategoryFilter(null)}
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
              Clear filter
            </button>
          )}
        </div>
      )}

      {/* Topics grid */}
      {!loading && !error && topics.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {topics.map((topic) => {
            const badge = proofBadgeLabel(topic.proofType);
            return (
              <div
                key={topic.id}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.3)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                }}
              >
                {/* Topic header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <TopicAvatar name={topic.title} image={topic.image} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link
                      href={`/topics/${topic.id}`}
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: 'var(--foreground)',
                        textDecoration: 'none',
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        lineHeight: 1.3,
                      }}
                    >
                      {topic.title}
                    </Link>
                    {topic.category && (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--muted)',
                          fontFamily: 'var(--font-mono)',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {topic.category.icon} {topic.category.name}
                      </span>
                    )}
                  </div>
                </div>

                {/* Description */}
                {topic.description && (
                  <p
                    style={{
                      fontSize: 13,
                      color: '#9ca3af',
                      margin: 0,
                      lineHeight: 1.5,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {topic.description}
                  </p>
                )}

                {/* Meta row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginTop: 'auto',
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {topic.memberCount} {topic.memberCount === 1 ? 'member' : 'members'}
                  </span>

                  {badge && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 9999,
                        background: 'rgba(120,140,255,0.1)',
                        border: '1px solid rgba(120,140,255,0.2)',
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 500,
                        letterSpacing: '0.02em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {badge}
                    </span>
                  )}
                </div>

                {/* Action button */}
                <div>
                  {topic.isMember ? (
                    <Link
                      href={`/topics/${topic.id}`}
                      style={{
                        display: 'inline-block',
                        padding: '6px 16px',
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--muted)',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        textDecoration: 'none',
                        fontFamily: 'var(--font-mono)',
                        transition: 'all 0.15s',
                        letterSpacing: '0.02em',
                      }}
                    >
                      View
                    </Link>
                  ) : (
                    <button
                      onClick={() => handleJoin(topic.id)}
                      disabled={joiningTopicId === topic.id}
                      style={{
                        padding: '6px 16px',
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#fff',
                        background: 'var(--accent)',
                        border: 'none',
                        borderRadius: 8,
                        cursor: joiningTopicId === topic.id ? 'wait' : 'pointer',
                        fontFamily: 'var(--font-mono)',
                        transition: 'all 0.15s',
                        letterSpacing: '0.02em',
                        opacity: joiningTopicId === topic.id ? 0.7 : 1,
                      }}
                    >
                      {joiningTopicId === topic.id ? 'Joining...' : 'Join'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CommunityLayout>
  );
}

// ─── Page Export ──────────────────────────────────────────────────────────────

export default function ExplorePage() {
  return (
    <Suspense>
      <ExplorePageInner />
    </Suspense>
  );
}
