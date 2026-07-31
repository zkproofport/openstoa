'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import TopicAvatar from '@/components/TopicAvatar';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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

function proofBadgeLabel(proofType: string, t: (key: string) => string): string | null {
  switch (proofType) {
    case 'kyc': return t('explorePage.proofBadge.kyc');
    case 'country': return t('explorePage.proofBadge.country');
    case 'google_workspace': return t('explorePage.proofBadge.googleWorkspace');
    case 'microsoft_365': return t('explorePage.proofBadge.microsoft365');
    case 'workspace': return t('explorePage.proofBadge.workspace');
    default: return null;
  }
}

// ─── Inner Component ─────────────────────────────────────────────────────────

function ExplorePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation();

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
      if (!res.ok) throw new Error(t('explorePage.loadFailed'));
      const data = await res.json();
      setTopics(data.topics ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('explorePage.unknownError'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            background: 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)',
            borderRadius: 'var(--radius-control)',
            marginBottom: 20,
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          <span>{t('explorePage.guestBanner')}</span>
          <Link
            href="/"
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 'var(--text-caption)',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {t('header.signIn')}
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
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: 0,
            fontFamily: 'var(--font-serif)',
          }}
        >
          {t('sidebar.exploreTopics')}
        </h1>
      </div>

      {/* Sort pills + Category filter */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          {(
            [
              { key: 'hot', label: t('explorePage.sort.hot') },
              { key: 'new', label: t('explorePage.sort.new') },
              { key: 'active', label: t('explorePage.sort.active') },
              { key: 'top', label: t('explorePage.sort.top') },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              style={{
                background: sortBy === key ? 'var(--accent)' : 'transparent',
                color: sortBy === key ? 'var(--color-text-inverted)' : 'var(--muted)',
                border: `1px solid ${sortBy === key ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-pill)',
                padding: '4px 14px',
                fontSize: 'var(--text-caption)',
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
              borderRadius: 'var(--radius-control)',
              padding: '5px 10px',
              fontSize: 'var(--text-caption)',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="">{t('explorePage.allCategories')}</option>
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
            padding: 'var(--space-4) 20px',
            background: 'color-mix(in srgb, var(--color-status-danger) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-status-danger) 20%, transparent)',
            borderRadius: 'var(--radius-card)',
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-status-danger)',
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
            borderRadius: 'var(--radius-modal)',
          }}
        >
          <p style={{ fontSize: 'var(--text-body-lg)', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 'var(--space-2)' }}>
            {t('explorePage.noTopicsFound')}
          </p>
          <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginBottom: 'var(--space-5)' }}>
            {categoryFilter ? t('explorePage.tryDifferentCategory') : t('explorePage.beFirstToCreate')}
          </p>
          {categoryFilter && (
            <button
              onClick={() => setCategoryFilter(null)}
              style={{
                background: 'var(--accent)',
                color: 'var(--color-text-inverted)',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: '10px var(--space-5)',
                fontSize: 'var(--text-body-sm)',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('explorePage.clearFilter')}
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
            const badge = proofBadgeLabel(topic.proofType, t);
            return (
              <div
                key={topic.id}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                }}
              >
                {/* Topic header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <TopicAvatar name={topic.title} image={topic.image} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <Link
                        href={`/topics/${topic.id}`}
                        style={{
                          fontSize: 'var(--text-body)',
                          fontWeight: 600,
                          color: 'var(--foreground)',
                          textDecoration: 'none',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.3,
                          minWidth: 0,
                        }}
                      >
                        {topic.title}
                      </Link>
                      {topic.isMember && (
                        // Success-tint Joined pill — mirrors PostCard joinedPill.
                        // Uses `.os-label` for the size/weight/uppercase-lang
                        // contract (was a bare 9px literal, below the 12px
                        // uppercase-label floor).
                        <span
                          className="os-label"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            color: 'var(--color-brand-accent)',
                            background: 'color-mix(in srgb, var(--color-brand-accent) 10%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                            borderRadius: 'var(--radius-control)',
                            padding: '1px 6px',
                            lineHeight: 1.2,
                            flexShrink: 0,
                          }}
                          aria-label={t('postCard.joinedAriaLabel')}
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          {t('postCard.joined')}
                        </span>
                      )}
                    </div>
                    {topic.category && (
                      <span
                        style={{
                          fontSize: 'var(--text-caption)',
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
                      fontSize: 'var(--text-caption)',
                      color: 'var(--color-text-secondary)',
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
                    gap: 'var(--space-2)',
                    flexWrap: 'wrap',
                    marginTop: 'auto',
                  }}
                >
                  <span
                    style={{
                      fontSize: 'var(--text-caption)',
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {topic.memberCount} {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
                  </span>

                  {badge && (
                    <span
                      style={{
                        fontSize: 'var(--text-caption)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-pill)',
                        background: 'var(--color-brand-primary-muted)',
                        border: '1px solid color-mix(in srgb, var(--color-brand-primary) 20%, transparent)',
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
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '6px var(--space-4)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 500,
                        color: 'var(--muted)',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-control)',
                        textDecoration: 'none',
                        fontFamily: 'var(--font-mono)',
                        transition: 'all 0.15s',
                        letterSpacing: '0.02em',
                        minHeight: 'var(--touch-target-min)',
                      }}
                    >
                      {t('explorePage.view')}
                    </Link>
                  ) : (
                    <button
                      onClick={() => handleJoin(topic.id)}
                      disabled={joiningTopicId === topic.id}
                      style={{
                        padding: '6px var(--space-4)',
                        fontSize: 'var(--text-caption)',
                        fontWeight: 600,
                        color: 'var(--color-text-inverted)',
                        background: 'var(--accent)',
                        border: 'none',
                        borderRadius: 'var(--radius-control)',
                        cursor: joiningTopicId === topic.id ? 'wait' : 'pointer',
                        fontFamily: 'var(--font-mono)',
                        transition: 'all 0.15s',
                        letterSpacing: '0.02em',
                        opacity: joiningTopicId === topic.id ? 0.7 : 1,
                        minHeight: 'var(--touch-target-min)',
                      }}
                    >
                      {joiningTopicId === topic.id ? t('joinPage.joining') : t('explorePage.join')}
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
