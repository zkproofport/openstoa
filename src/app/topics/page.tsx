'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import TopicAvatar from '@/components/TopicAvatar';
import ImageLightbox from '@/components/ImageLightbox';
import { formatDate } from '@/lib/utils';

interface Topic {
  id: string;
  title: string;
  description?: string | null;
  image?: string | null;
  memberCount?: number;
  requiresCountryProof: boolean;
  allowedCountries?: string[] | null;
  visibility?: string;
  createdAt: string;
  isMember?: boolean;
}

function TopicsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'top' | 'active'>('hot');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(new Set());
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(
    searchParams.get('category'),
  );

  function handleImageClick(src: string) {
    if (window.innerWidth <= 768 || 'ontouchstart' in window) {
      setLightboxSrc(src);
    } else {
      window.open(src, '_blank');
    }
  }

  useEffect(() => {
    const initialCategory = searchParams.get('category');
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) {
          setIsGuest(true);
          setSessionChecked(true);
          loadTopics('hot', initialCategory);
          return;
        }
        if (!data.nickname) {
          router.replace('/profile');
          return;
        }
        setSessionChecked(true);
        loadTopics('hot', initialCategory);
      })
      .catch(() => {
        setIsGuest(true);
        setSessionChecked(true);
        loadTopics('hot', initialCategory);
      });
  }, [router]);

  useEffect(() => {
    if (sessionChecked) {
      loadTopics(sortBy, activeCategory);
    }
  }, [sortBy, activeCategory]);

  async function loadTopics(sort: string, category: string | null) {
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
  }

  async function handleJoin(topicId: string) {
    setJoiningId(topicId);
    try {
      const res = await fetch(`/api/topics/${topicId}/join`, { method: 'POST' });
      if (res.status === 202) {
        setPendingRequests((prev) => new Set(prev).add(topicId));
      } else if (res.status === 201) {
        await loadTopics(sortBy, activeCategory);
      } else {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to join topic');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join topic');
    } finally {
      setJoiningId(null);
    }
  }

  function handleCategorySelect(slug: string | null) {
    setActiveCategory(slug);
  }

  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
      activeCategory={activeCategory}
      onCategorySelect={handleCategorySelect}
    >
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

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
            }}
          >
            {activeCategory ? 'Topics' : 'All Topics'}
          </h1>
          {activeCategory && (
            <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 2 }}>
              Filtered by category
            </p>
          )}
        </div>
      </div>

      {/* Sort pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {(
          [
            { key: 'hot', label: '\uD83D\uDD25 Hot' },
            { key: 'new', label: '\uD83C\uDD95 New' },
            { key: 'top', label: '\uD83D\uDC65 Top' },
            { key: 'active', label: '\u26A1 Active' },
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
              padding: '4px 12px',
              fontSize: 13,
              fontWeight: sortBy === key ? 600 : 400,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
              transition: 'all 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

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

      {error && (
        <div
          style={{
            padding: '16px 20px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 10,
            fontSize: 14,
            color: '#ef4444',
            fontFamily: 'monospace',
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && topics.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '80px 20px',
            border: '1px dashed var(--border)',
            borderRadius: 16,
          }}
        >
          <p style={{ fontSize: 32, marginBottom: 12 }}>{'\uD83C\uDF31'}</p>
          <p
            style={{
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: 8,
            }}
          >
            {activeCategory ? 'No topics in this category' : 'No topics yet'}
          </p>
          <p style={{ fontSize: 16, color: 'var(--muted)', marginBottom: 24 }}>
            {activeCategory
              ? 'Try selecting a different category or create a new topic.'
              : 'No topics in the community yet'}
          </p>
          {!isGuest && (
            <Link
              href="/topics/new"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                textDecoration: 'none',
                borderRadius: 8,
                padding: '10px 24px',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Create first topic
            </Link>
          )}
        </div>
      )}

      {!loading && !error && topics.length > 0 && (
        <div className="flex flex-col gap-3">
          {topics.map((topic) => {
            const isMember = topic.isMember !== false;
            const isPublic = topic.visibility === 'public' || !topic.visibility;
            const isPrivate = topic.visibility === 'private';

            const canClick = isGuest
              ? isPublic
              : isMember;

            const cardContent = (
              <div
                style={{
                  padding: '18px 22px',
                  background: 'var(--surface, #0c0e18)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  transition: 'border-color 0.15s, background 0.15s',
                  cursor: canClick ? 'pointer' : 'default',
                  opacity: isGuest && isPrivate ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                  if (canClick) {
                    (e.currentTarget as HTMLDivElement).style.borderColor =
                      'rgba(120,140,255,0.3)';
                    (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-hover, #10131f)';
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--surface, #0c0e18)';
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 14,
                  }}
                >
                  <TopicAvatar
                    name={topic.title}
                    image={topic.image}
                    size={40}
                    onClick={topic.image ? () => handleImageClick(topic.image!) : undefined}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 4 }}>
                      <h2
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          letterSpacing: '-0.02em',
                          margin: 0,
                          color: 'var(--foreground)',
                        }}
                      >
                        {topic.visibility === 'private' && '\uD83D\uDD12 '}{topic.title}
                      </h2>
                      {topic.requiresCountryProof && (
                        <span
                          style={{
                            fontSize: 12,
                            fontFamily: 'monospace',
                            background: 'rgba(59,130,246,0.12)',
                            color: 'var(--accent)',
                            border: '1px solid rgba(59,130,246,0.2)',
                            padding: '1px 6px',
                            borderRadius: 4,
                          }}
                        >
                          country gated
                        </span>
                      )}
                    </div>
                    {topic.description && (
                      <p
                        style={{
                          fontSize: 13,
                          color: 'var(--muted)',
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
                  </div>

                  <div
                    style={{
                      textAlign: 'right',
                      flexShrink: 0,
                      fontSize: 13,
                      color: 'var(--muted)',
                      lineHeight: 1.8,
                    }}
                  >
                    {topic.memberCount != null && (
                      <div>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            color: 'var(--foreground)',
                            fontWeight: 600,
                          }}
                        >
                          {topic.memberCount}
                        </span>{' '}
                        members
                      </div>
                    )}
                    <div style={{ fontSize: 12 }}>{formatDate(topic.createdAt)}</div>
                    {/* Guest: show "Members only" for private */}
                    {isGuest && isPrivate && (
                      <div style={{ marginTop: 6 }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: '#666',
                            fontFamily: 'monospace',
                          }}
                        >
                          Members only
                        </span>
                      </div>
                    )}
                    {/* Authenticated non-member: show join buttons */}
                    {!isGuest && !isMember && (
                      <div style={{ marginTop: 6 }}>
                        {topic.requiresCountryProof ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontFamily: 'monospace',
                              background: 'rgba(59,130,246,0.08)',
                              color: 'var(--muted)',
                              border: '1px solid var(--border)',
                              padding: '2px 7px',
                              borderRadius: 4,
                            }}
                          >
                            Requires Country Proof
                          </span>
                        ) : pendingRequests.has(topic.id) ? (
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: '#eab308',
                              background: 'rgba(234,179,8,0.1)',
                              border: '1px solid rgba(234,179,8,0.2)',
                              padding: '3px 10px',
                              borderRadius: 6,
                            }}
                          >
                            Pending...
                          </span>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleJoin(topic.id);
                            }}
                            disabled={joiningId === topic.id}
                            style={{
                              background: 'var(--accent)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 6,
                              padding: '5px 14px',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: joiningId === topic.id ? 'not-allowed' : 'pointer',
                              opacity: joiningId === topic.id ? 0.7 : 1,
                            }}
                          >
                            {joiningId === topic.id ? 'Joining\u2026' : topic.visibility === 'private' ? 'Request to Join' : 'Join'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );

            return canClick ? (
              <Link key={topic.id} href={`/topics/${topic.id}`} style={{ textDecoration: 'none' }}>
                {cardContent}
              </Link>
            ) : (
              <div key={topic.id}>{cardContent}</div>
            );
          })}
        </div>
      )}
    </CommunityLayout>
  );
}

export default function TopicsPage() {
  return (
    <Suspense>
      <TopicsPageInner />
    </Suspense>
  );
}
