'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
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

export default function TopicsPage() {
  const router = useRouter();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'all' | 'my'>('all');
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'top' | 'active'>('hot');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(new Set());
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
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          router.replace('/');
          return;
        }
        if (!data.nickname) {
          router.replace('/profile');
          return;
        }
        loadTopics();
      })
      .catch(() => router.replace('/'));
  }, [router]);

  useEffect(() => {
    loadTopics();
  }, [view, sortBy]);

  async function loadTopics() {
    setLoading(true);
    setError(null);
    try {
      const url = view === 'all' ? `/api/topics?view=all&sort=${sortBy}` : '/api/topics';
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
        // Join request submitted for private topic
        setPendingRequests((prev) => new Set(prev).add(topicId));
      } else if (res.status === 201) {
        await loadTopics();
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

  const emptyMessage =
    view === 'all'
      ? 'No topics in the community yet'
      : "You haven't joined any topics yet. Browse all topics to find one.";

  return (
    <>
      <Header />
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
      <div style={{ paddingTop: 40, paddingBottom: 80 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                margin: 0,
              }}
            >
              Topics
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 4 }}>
              {topics.length > 0
                ? `${topics.length} topic${topics.length !== 1 ? 's' : ''}`
                : 'Explore community topics'}
            </p>
          </div>
          <Link
            href="/topics/new"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              textDecoration: 'none',
              borderRadius: 8,
              padding: '9px 20px',
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            + Create Topic
          </Link>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '1px solid var(--border)',
            marginBottom: 28,
          }}
        >
          {(['all', 'my'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setView(tab)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: view === tab ? '2px solid var(--accent)' : '2px solid transparent',
                color: view === tab ? 'var(--accent)' : 'var(--muted)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: view === tab ? 600 : 400,
                padding: '8px 16px',
                marginBottom: -1,
                letterSpacing: '-0.01em',
                transition: 'color 0.15s',
              }}
            >
              {tab === 'all' ? 'All Topics' : 'My Topics'}
            </button>
          ))}
        </div>

        {/* Sort pills — only shown for All Topics */}
        {view === 'all' && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
            {(
              [
                { key: 'hot', label: '🔥 Hot' },
                { key: 'new', label: '🆕 New' },
                { key: 'top', label: '👥 Top' },
                { key: 'active', label: '⚡ Active' },
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
                  fontSize: 12,
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
        )}

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
            <p style={{ fontSize: 32, marginBottom: 12 }}>🌱</p>
            <p
              style={{
                fontSize: 16,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                marginBottom: 8,
              }}
            >
              {view === 'all' ? 'No topics yet' : 'No joined topics'}
            </p>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 24 }}>
              {emptyMessage}
            </p>
            {view === 'all' ? (
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
            ) : (
              <button
                onClick={() => setView('all')}
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '10px 24px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Browse all topics
              </button>
            )}
          </div>
        )}

        {!loading && !error && topics.length > 0 && (
          <div className="flex flex-col gap-3">
            {topics.map((topic) => {
              const isMember = topic.isMember !== false;
              const cardContent = (
                <div
                  style={{
                    padding: '20px 24px',
                    background: '#0d0d0d',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    transition: 'border-color 0.15s, background 0.15s',
                    cursor: isMember ? 'pointer' : 'default',
                  }}
                  onMouseEnter={(e) => {
                    if (isMember) {
                      (e.currentTarget as HTMLDivElement).style.borderColor =
                        'rgba(59,130,246,0.4)';
                      (e.currentTarget as HTMLDivElement).style.background = '#111';
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
                    (e.currentTarget as HTMLDivElement).style.background = '#0d0d0d';
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                    }}
                  >
                    <TopicAvatar
                      name={topic.title}
                      image={topic.image}
                      size={42}
                      onClick={topic.image ? () => handleImageClick(topic.image!) : undefined}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 6 }}>
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
                        <p
                          style={{
                            fontSize: 14,
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
                        fontSize: 12,
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
                      <div>{formatDate(topic.createdAt)}</div>
                      {!isMember && (
                        <div style={{ marginTop: 8 }}>
                          {topic.requiresCountryProof ? (
                            <span
                              style={{
                                fontSize: 11,
                                fontFamily: 'monospace',
                                background: 'rgba(59,130,246,0.08)',
                                color: 'var(--muted)',
                                border: '1px solid var(--border)',
                                padding: '3px 8px',
                                borderRadius: 4,
                              }}
                            >
                              Requires Country Proof
                            </span>
                          ) : pendingRequests.has(topic.id) ? (
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 500,
                                color: '#eab308',
                                background: 'rgba(234,179,8,0.1)',
                                border: '1px solid rgba(234,179,8,0.2)',
                                padding: '4px 12px',
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
                                padding: '6px 16px',
                                fontSize: 13,
                                fontWeight: 600,
                                cursor: joiningId === topic.id ? 'not-allowed' : 'pointer',
                                opacity: joiningId === topic.id ? 0.7 : 1,
                              }}
                            >
                              {joiningId === topic.id ? 'Joining…' : topic.visibility === 'private' ? 'Request to Join' : 'Join'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );

              return isMember ? (
                <Link key={topic.id} href={`/topics/${topic.id}`} style={{ textDecoration: 'none' }}>
                  {cardContent}
                </Link>
              ) : (
                <div key={topic.id}>{cardContent}</div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

