'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
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
  // A flag, not a message: the raw exception ("ECONNREFUSED 10.0.0.1:5432")
  // says nothing to a reader and leaks infrastructure. The copy below is
  // fixed and explicitly denies the "you have nothing" reading.
  const [failed, setFailed] = useState(false);
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'active' | 'top'>(
    (searchParams.get('sort') as 'hot' | 'new' | 'active' | 'top') || 'hot',
  );
  const [categoryFilter, setCategoryFilter] = useState<string | null>(
    searchParams.get('category'),
  );
  const [isGuest, setIsGuest] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [joiningTopicId, setJoiningTopicId] = useState<string | null>(null);
  /** Why the last join did not happen, or null. Cleared on the next try. */
  const [joinError, setJoinError] = useState<string | null>(null);
  // `joiningTopicId` drives the DISABLED state, which is a render away; two
  // taps inside one frame (a double-tap, or a stuck click) both get through it
  // and issue two POSTs. The ref closes that window synchronously. Same guard,
  // same reason as `dmInFlightRef` in topics/[topicId]/members/page.tsx.
  const joinInFlightRef = useRef(false);

  /*
   * Acts once the SERVER has answered. A seeded session is a hint, and neither
   * a redirect nor a "you are a guest" verdict should rest on a hint — the
   * previous code only ever ran after the fetch settled, and a failed lookup
   * settles as `null`, which is the guest branch.
   */
  const { session, isVerified } = useSession();
  // ── Auth check ──
  useEffect(() => {
    if (!isVerified) return;
    if (!session?.userId) {
      setIsGuest(true);
      setSessionChecked(true);
      return;
    }
    if (!session.nickname) {
      router.replace('/profile');
      return;
    }
    setSessionChecked(true);
  }, [router, session, isVerified]);

  // ── Fetch categories ──
  useEffect(() => {
    apiFetch('/api/categories')
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
    setFailed(false);
    try {
      let url = `/api/topics?view=all&sort=${sort}`;
      if (category) {
        url += `&category=${encodeURIComponent(category)}`;
      }
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      /*
       * The caller's own space arrives BESIDE the list, and belongs on top of it.
       *
       * The server keeps it out of `topics` deliberately: that array promises
       * every row in it matched the sort and the category filter, and the space
       * matches neither — it has no category. Putting it back at the front here
       * is what makes it reachable from this page without making that promise
       * false. Filtered so a server that later includes it cannot produce two.
       */
      const rows = (data.topics ?? []) as Topic[];
      const pinned = data.pinned as Topic | null | undefined;
      setTopics(pinned ? [pinned, ...rows.filter((t) => t.id !== pinned.id)] : rows);
    } catch {
      setFailed(true);
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
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    setJoiningTopicId(topicId);
    setJoinError(null);
    try {
      const res = await apiFetch(`/api/topics/${topicId}/join`, { method: 'POST' });
      if (res.ok) {
        setTopics((prev) =>
          prev.map((t) => (t.id === topicId ? { ...t, isMember: true, memberCount: t.memberCount + 1 } : t)),
        );
      } else {
        /*
         * A refusal has to reach the person.
         *
         * This branch did not exist: a 403 left the button snapping back to
         * "Join" with nothing said, which reads as a broken button rather than
         * as a locked door. The server writes its refusals for people ("This
         * topic requires an invite code"), so that sentence is the one shown.
         */
        const reason = await res
          .json()
          .then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : null))
          .catch(() => null);
        setJoinError(reason ?? t('explorePage.joinFailed'));
      }
    } catch {
      // The request never left: the same treatment, in the reader's terms.
      setJoinError(t('explorePage.joinOffline'));
    } finally {
      joinInFlightRef.current = false;
      setJoiningTopicId(null);
    }
  }

  return (
    <CommunityLayout
      isGuest={isGuest}
      sessionChecked={sessionChecked}
    >
      {/* Guest banner — same treatment as the feed's (src/app/topics/page.tsx),
          so the two browse surfaces greet a signed-out reader identically. */}
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
          <span>{t('explorePage.guestBanner')}</span>
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
            {t('header.signIn')}
          </Link>
        </div>
      )}

      {/* Page heading — same step, weight and tracking as the feed's, and no
          serif face: Explore and Feed are two views of one library, so they
          must not read as two products. */}
      <div style={{ marginBottom: 'var(--space-5)' }}>
        <h1
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            margin: 0,
          }}
        >
          {t('sidebar.exploreTopics')}
        </h1>
      </div>

      {/* Sort chips + category filter.
          `.os-chip` + `aria-pressed` is the feed's control verbatim: selection
          reads as RAISED (ground + rule), never as a saturated brand fill — a
          row of filled chips above the list shouts louder than the topics,
          which are the content. `aria-pressed` is also what makes the state
          audible to a screen reader, which a background color alone is not. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-5)',
          flexWrap: 'wrap',
        }}
      >
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
            type="button"
            onClick={() => setSortBy(key)}
            className="os-chip"
            aria-pressed={sortBy === key}
          >
            {label}
          </button>
        ))}

        {/* Category filter. `.os-locale-select` is this app's ONE select
            treatment (custom chevron, token ground/border, 44px tall,
            `--text-body` 16px — under 16px iOS Safari zooms the whole page on
            focus). Reused rather than re-styled so every select in the product
            is the same control. */}
        {categories.length > 0 && (
          <select
            className="os-locale-select"
            aria-label={t('explorePage.allCategories')}
            value={categoryFilter ?? ''}
            onChange={(e) => setCategoryFilter(e.target.value || null)}
            style={{ marginLeft: 'auto' }}
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
          <Spinner />
        </div>
      )}

      {/* Error state. A DISTINCT state from empty, on purpose: a failed request
          used to render a red bar carrying the raw exception and no way
          forward, which reads to a user as "there are no topics". Same
          treatment as the feed's error (src/app/topics/page.tsx). */}
      {!loading && failed && (
        <div
          role="alert"
          style={{
            textAlign: 'center',
            padding: 'var(--space-7) var(--space-5)',
            border: '1px solid var(--color-status-danger)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--color-bg-secondary)',
          }}
        >
          <p
            style={{
              fontSize: 'var(--text-body-lg)', fontWeight: 600,
              color: 'var(--color-status-danger)', margin: '0 0 var(--space-2)',
            }}
          >
            {t('explorePage.loadFailed')}
          </p>
          <p
            style={{
              fontSize: 'var(--text-body-sm)', color: 'var(--color-text-secondary)',
              margin: '0 0 var(--space-5)',
            }}
          >
            {t('explorePage.errorBody')}
          </p>
          <button
            type="button"
            onClick={() => loadTopics(sortBy, categoryFilter)}
            className="os-button os-button-primary"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Empty state — two genuinely different situations, each with its own
          title: "your filter excluded everything" is recoverable right here,
          "nothing exists yet" is not a filter problem and gets no dead button. */}
      {!loading && !failed && topics.length === 0 && (
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
            {categoryFilter ? t('explorePage.noTopicsMatchFilter') : t('explorePage.noTopicsFound')}
          </p>
          <p
            style={{
              fontSize: 'var(--text-body-sm)', color: 'var(--color-text-secondary)',
              margin: '0 0 var(--space-5)',
            }}
          >
            {categoryFilter ? t('explorePage.tryDifferentCategory') : t('explorePage.beFirstToCreate')}
          </p>
          {categoryFilter && (
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              className="os-button os-button-primary"
            >
              {t('explorePage.clearFilter')}
            </button>
          )}
        </div>
      )}

      {/*
        Why a join did not happen.
        
        Above the grid rather than inside a card: the button that failed snaps
        back to its resting state immediately, so a message attached to it would
        appear next to a control that looks untouched. This sits where the
        reader's eye already goes after pressing.
      */}
      {joinError && (
        <div
          role="alert"
          data-testid="join-error"
          style={{
            margin: '0 0 var(--space-4)',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-card)',
            border: '1px solid color-mix(in srgb, var(--color-status-warning) 30%, transparent)',
            background: 'color-mix(in srgb, var(--color-status-warning) 10%, transparent)',
            color: 'var(--color-status-warning)',
            fontSize: 'var(--text-body-sm)',
          }}
        >
          {joinError}
        </div>
      )}

      {/* Topics grid. `min(260px, 100%)` rather than a bare 260px track: at a
          320px viewport a fixed minimum overflows the column, and a horizontal
          scrollbar on the browse page is the one thing no phone reader wants. */}
      {!loading && !failed && topics.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          {topics.map((topic) => {
            const badge = proofBadgeLabel(topic.proofType, t);
            const joining = joiningTopicId === topic.id;
            return (
              <div
                key={topic.id}
                data-testid="topic-card"
                style={{
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-card)',
                  padding: 'var(--space-4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                  transition: 'border-color 0.15s',
                }}
                // Hover raises the rule one step; it does NOT switch to brand.
                // A grid of brand-outlined boxes is the same "everything is
                // shouting" defect as the filled Join buttons were.
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-strong)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
                }}
              >
                {/* Topic header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <TopicAvatar name={topic.title} image={topic.image} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
                      <Link
                        href={`/topics/${topic.id}`}
                        data-testid="topic-card-title"
                        style={{
                          fontSize: 'var(--text-body)',
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                          textDecoration: 'none',
                          // Layout-only truncation: a 500-character title must
                          // not push the Joined pill out of the row. The value
                          // stays intact in the DOM.
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
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        {topic.category.icon} {topic.category.name}
                      </span>
                    )}
                  </div>
                </div>

                {/* Description. `trim()` before the truthiness test so a
                    whitespace-only value renders nothing rather than an empty
                    two-line gap. */}
                {topic.description && topic.description.trim().length > 0 && (
                  <p
                    style={{
                      fontSize: 'var(--text-body-sm)',
                      color: 'var(--color-text-secondary)',
                      margin: 0,
                      lineHeight: 'var(--leading-base)',
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
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {topic.memberCount} {topic.memberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}
                  </span>

                  {badge && (
                    // Requirement, not decoration: a quiet outline in the
                    // tertiary voice, the same weight the on-chain chip carries
                    // on PostCard. It states a fact about the topic; it is not
                    // an action competing with Join.
                    <span
                      style={{
                        fontSize: 'var(--text-caption)',
                        padding: '1px var(--space-2)',
                        borderRadius: 'var(--radius-control)',
                        background: 'transparent',
                        border: '1px solid var(--color-border-default)',
                        color: 'var(--color-text-tertiary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {badge}
                    </span>
                  )}
                </div>

                {/* Action. `.os-button` (neutral raised), NOT
                    `.os-button-primary`: every card in the grid carries one, and
                    a saturated brand fill repeated N times reads as N calls to
                    action competing with each other and with the topic names.
                    Primary fill is reserved for the single action in a state
                    that has exactly one (the empty state's Clear filter). */}
                <div>
                  {topic.isMember ? (
                    <Link href={`/topics/${topic.id}`} className="os-button">
                      {t('explorePage.view')}
                    </Link>
                  ) : topic.visibility !== 'public' ? (
                    /*
                     * No Join button on a topic that cannot be joined this way.
                     *
                     * `POST /join` answers 403 to everything that is not public
                     * — the invite link is the only door, because for the
                     * scoped tiers that link is also what carries the chat
                     * history keys. Offering the button anyway produced the
                     * reported behaviour: press, "Joining…", back to "Join",
                     * nothing said, and a 403 in the console. Saying what the
                     * topic IS costs the same space and is true.
                     */
                    <span
                      className="os-label"
                      style={{ color: 'var(--muted)' }}
                      data-testid="invite-only-note"
                    >
                      {t('explorePage.inviteOnly')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleJoin(topic.id)}
                      disabled={joining}
                      className="os-button"
                      style={{ cursor: joining ? 'wait' : 'pointer', opacity: joining ? 0.7 : 1 }}
                    >
                      {joining ? t('joinPage.joining') : t('explorePage.join')}
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
