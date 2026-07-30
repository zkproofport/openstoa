'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import TopicAvatar from '@/components/TopicAvatar';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import {
  DEFAULT_LEFT_NAV_GROUP_STATE,
  formatNavBadgeCount,
  formatNavCount,
  readLeftNavGroupState,
  writeLeftNavGroupState,
  type LeftNavGroupId,
  type LeftNavGroupState,
} from '@/lib/leftNav';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  sortOrder: number;
}

interface TopicItem {
  id: string;
  title: string;
  image?: string | null;
  memberCount?: number;
  categorySlug?: string | null;
}

interface Tag {
  id: string;
  name: string;
  slug: string;
  postCount: number;
}

interface CommunityStats {
  totalTopics: number;
  totalMembers: number;
}

interface LeftSidebarProps {
  isGuest: boolean;
  sessionChecked: boolean;
  activeCategory?: string | null;
  onCategorySelect?: (slug: string | null) => void;
  onTagSelect?: (slug: string | null) => void;
  activeTag?: string | null;
  viewMode?: 'all' | 'my';
  onViewChange?: (view: 'all' | 'my') => void;
  /** Opens the chat rail (`ChatRail.tsx`, owned by `CommunityLayout`) landed
   *  on the room list. Omitted entirely for guests — there is no chat for a
   *  guest to open, so the entry is hidden rather than rendered disabled. */
  onOpenChat?: () => void;
  /** Unread message count across all rooms, shown as a solid-brand badge on
   *  the Chat row (capped at "99+"). `undefined`/0 renders no badge — there
   *  is no live unread-count source wired into the app yet (no caller
   *  currently passes this), so the prop exists as a ready capability: it
   *  is unit-tested directly, and a future unread-tracking feature can wire
   *  it up here without touching this component's rendering contract. */
  unreadChatCount?: number;
}

// ─── Fallback categories ─────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'base-layer2', name: 'Base & Layer 2', slug: 'base-layer2', icon: '🔵', sortOrder: 1 },
  { id: 'defi-trading', name: 'DeFi & Trading', slug: 'defi-trading', icon: '📈', sortOrder: 2 },
  { id: 'nft-gaming', name: 'NFT & Gaming', slug: 'nft-gaming', icon: '🎮', sortOrder: 3 },
  { id: 'privacy-zk', name: 'Privacy & ZK', slug: 'privacy-zk', icon: '🔐', sortOrder: 4 },
  { id: 'development', name: 'Development', slug: 'development', icon: '💻', sortOrder: 5 },
  { id: 'governance', name: 'Governance', slug: 'governance', icon: '🏛️', sortOrder: 6 },
  { id: 'free-talk', name: 'Free Talk', slug: 'free-talk', icon: '💬', sortOrder: 7 },
  { id: 'announcements', name: 'Announcements', slug: 'announcements', icon: '📢', sortOrder: 8 },
];

// ─── Styles ──────────────────────────────────────────────────────────────────

const sidebarCardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--space-4)',
  marginBottom: 'var(--space-3)',
};

// Font-size/weight/family + the language-conditional uppercase+tracking come
// from the `.os-label` utility class (globals.css) — apply that class
// alongside this style object at each usage site below. Uppercase +
// letter-spacing on Hangul reads as broken kerning, so `.os-label` only
// applies them for :lang(en); this object carries the language-agnostic
// remainder only.
const sectionHeadingStyle: React.CSSProperties = {
  color: 'var(--muted)',
  marginBottom: 10,
  padding: '0 var(--space-1)',
};

/**
 * Shared row treatment for every top-level nav item — the design prototype's
 * `.ni`: a real touch target (44px, not the previous ~34px), token radius,
 * and an explicit active state (brand-muted background + brand text/icon)
 * that ALWAYS pairs with a real `aria-current="page"` attribute at the call
 * site below (previously this was color-only — nothing exposed "this is the
 * current view" to assistive tech at all).
 */
function navRowStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    minHeight: 'var(--touch-target-min)',
    padding: '0 var(--space-3)',
    borderRadius: 'var(--radius-control)',
    cursor: 'pointer',
    fontSize: 'var(--text-body-sm)',
    color: active ? 'var(--accent)' : 'var(--foreground)',
    background: active ? 'var(--color-brand-primary-muted)' : 'transparent',
    transition: 'background 0.12s, color 0.12s',
    textDecoration: 'none',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    fontWeight: active ? 650 : 400,
    lineHeight: 1.4,
  };
}

/** Icon column — fixed width so labels align, but the width is a small icon
 *  glyph's box, never a text container (long Korean labels still get the
 *  full remaining width via the label span's own `flex: 1, minWidth: 0`). */
function navIconStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    flexShrink: 0,
    fontSize: 15,
    color: active ? 'var(--accent)' : 'var(--muted)',
  };
}

/** Label span — `flex: 1, minWidth: 0` + ellipsis so a long Korean label
 *  (Korean routinely renders longer than the English source string) never
 *  pushes a trailing count/badge out of the row or wraps the row taller. */
const navLabelStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  flex: 1,
  minWidth: 0,
};

/** Right-aligned monospace count (design prototype's `.n`) — rendered even
 *  at 0 (see `formatNavCount`); the caller renders nothing at all when it
 *  has no count data for a row, which is a visibly different state. */
const navCountStyle: React.CSSProperties = {
  marginLeft: 'auto',
  flexShrink: 0,
  fontSize: 'var(--text-label)',
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-text-tertiary)',
};

/** Solid-brand unread badge (design prototype's `.badge`) — only rendered
 *  for a count > 0 (see `formatNavBadgeCount`), capped at "99+". */
const navBadgeStyle: React.CSSProperties = {
  marginLeft: 'auto',
  flexShrink: 0,
  background: 'var(--color-brand-primary)',
  color: 'var(--color-text-inverted)',
  borderRadius: 'var(--radius-pill)',
  fontSize: 'var(--text-label)',
  fontFamily: 'var(--font-mono)',
  lineHeight: 1.7,
  padding: '0 7px',
};

const chevronStyle = (expanded: boolean): React.CSSProperties => ({
  transition: 'transform 0.15s',
  transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
  flexShrink: 0,
});

const Chevron = ({ expanded }: { expanded: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={chevronStyle(expanded)}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

/**
 * A collapsible left-nav section (design prototype's `<details class="grp">`).
 * `open` is fully controlled by the parent — the summary's click handler
 * calls `preventDefault()` and drives the toggle through React state instead
 * of relying on the browser's native details/summary toggle, so behavior
 * does not depend on a specific engine's implementation of that toggle and
 * stays perfectly in sync with the persisted state in `leftNav.ts`. Keyboard
 * activation still works: `<summary>` has built-in Enter/Space activation
 * behavior per the HTML spec, which fires a `click` — this handler catches
 * that the same as a pointer click.
 */
function NavGroup({
  id,
  label,
  open,
  onToggle,
  children,
}: {
  id: LeftNavGroupId;
  label: string;
  open: boolean;
  onToggle: (id: LeftNavGroupId) => void;
  children: React.ReactNode;
}) {
  return (
    <details open={open} style={{ marginBottom: 'var(--space-5)' }}>
      <summary
        className="os-label os-nav-summary os-nav-row"
        onClick={(e) => {
          e.preventDefault();
          onToggle(id);
        }}
        style={{
          ...sectionHeadingStyle,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 'var(--touch-target-min)',
          borderRadius: 'var(--radius-control)',
        }}
      >
        <span>{label}</span>
        <Chevron expanded={open} />
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </details>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LeftSidebar({
  isGuest,
  sessionChecked,
  activeCategory,
  onCategorySelect,
  onTagSelect,
  activeTag,
  viewMode,
  onViewChange,
  onOpenChat,
  unreadChatCount,
}: LeftSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [allTopics, setAllTopics] = useState<TopicItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [stats, setStats] = useState<CommunityStats>({ totalTopics: 0, totalMembers: 0 });
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [topicSearch, setTopicSearch] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  // SSR-safe default (all groups open, matching the pre-existing
  // always-expanded layout) — the persisted preference is applied
  // client-side right after, same pattern `CommunityLayout` uses for
  // `railOpen` (localStorage does not exist during server render).
  const [groupState, setGroupState] = useState<LeftNavGroupState>(DEFAULT_LEFT_NAV_GROUP_STATE);

  useEffect(() => {
    setGroupState(readLeftNavGroupState());
  }, []);

  function toggleGroup(id: LeftNavGroupId) {
    setGroupState((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      writeLeftNavGroupState(next);
      return next;
    });
  }

  // Fetch categories from API, fall back to defaults
  useEffect(() => {
    fetch('/api/categories')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.categories && data.categories.length > 0) {
          setCategories(data.categories);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch all topics (for grouping under categories)
  useEffect(() => {
    fetch('/api/topics?view=all&sort=hot&limit=50')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.topics) {
          setAllTopics(data.topics);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch community stats from dedicated endpoint
  useEffect(() => {
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setStats({
            totalTopics: data.totalTopics ?? 0,
            totalMembers: data.totalMembers ?? 0,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Fetch popular tags
  useEffect(() => {
    fetch('/api/tags')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.tags) {
          setTags(data.tags.slice(0, 12));
        }
      })
      .catch(() => {});
  }, []);

  // Group topics by category
  const topicsByCategory = useMemo(() => {
    const map: Record<string, TopicItem[]> = {};
    for (const topic of allTopics) {
      const catSlug = topic.categorySlug ?? 'uncategorized';
      if (!map[catSlug]) map[catSlug] = [];
      map[catSlug].push(topic);
    }
    return map;
  }, [allTopics]);

  // Filter topics by search
  const searchResults = useMemo(() => {
    if (!topicSearch.trim()) return [];
    const q = topicSearch.toLowerCase();
    return allTopics.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 8);
  }, [topicSearch, allTopics]);

  // Determine if we're on a specific topic page
  const topicMatch = pathname.match(/^\/topics\/([^/]+)/);
  const activeTopicId = topicMatch ? topicMatch[1] : null;

  function toggleCategory(slug: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }

  const startTopicActive = pathname === '/topics/new';
  const allActive = viewMode !== 'my' && !activeCategory && !activeTopicId;
  const myTopicsActive = viewMode === 'my';
  const exploreActive = pathname === '/topics/explore';
  const recordedActive = pathname === '/recorded';
  const exploreCount = formatNavCount(stats.totalTopics);
  const chatBadge = formatNavBadgeCount(unreadChatCount);

  return (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Topic Search */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ position: 'relative' }}>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="var(--muted)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder={t('sidebar.searchPlaceholder')}
            value={topicSearch}
            onChange={(e) => setTopicSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px 8px 32px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-control)',
              color: 'var(--foreground)',
              // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
              fontSize: 'var(--text-body)',
              outline: 'none',
              fontFamily: 'var(--font-mono)',
              transition: 'border-color 0.15s',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; }}
            onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
          />
        </div>

        {/* Search results dropdown */}
        {searchResults.length > 0 && (
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginTop: 4,
            padding: '4px 0',
            maxHeight: 240,
            overflowY: 'auto',
          }}>
            {searchResults.map((topic) => (
              <Link
                key={topic.id}
                href={`/topics/${topic.id}`}
                onClick={() => setTopicSearch('')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  textDecoration: 'none',
                  color: 'var(--foreground)',
                  fontSize: 13,
                  transition: 'background 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <TopicAvatar name={topic.title} image={topic.image} size={20} />
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  flex: 1,
                  minWidth: 0,
                }}>
                  {topic.title}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Start a Topic -- always visible, redirects to login if guest */}
      {sessionChecked && (
        <Link
          href={isGuest ? '/?returnTo=%2Ftopics%2Fnew' : '/topics/new'}
          className="os-nav-row"
          aria-current={startTopicActive ? 'page' : undefined}
          onMouseEnter={() => setHoveredItem('start-topic')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...navRowStyle(startTopicActive),
            marginBottom: 12,
            ...(hoveredItem === 'start-topic' && !startTopicActive ? { background: 'var(--surface-hover)' } : {}),
          }}
        >
          <span style={navIconStyle(startTopicActive)}>+</span>
          <span style={navLabelStyle}>{t('sidebar.startTopic')}</span>
        </Link>
      )}

      {/* Browse — All / Explore / My topics / On-chain records */}
      <NavGroup id="browse" label={t('sidebar.browse')} open={groupState.browse} onToggle={toggleGroup}>
        <button
          type="button"
          className="os-nav-row"
          aria-current={allActive ? 'page' : undefined}
          onClick={() => {
            if (onViewChange) {
              onViewChange('all');
            } else if (onCategorySelect) {
              onCategorySelect(null);
            } else {
              router.push('/topics');
            }
          }}
          onMouseEnter={() => setHoveredItem('all')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...navRowStyle(allActive),
            ...(hoveredItem === 'all' && !allActive ? { background: 'var(--surface-hover)' } : {}),
          }}
        >
          <span style={navIconStyle(allActive)}>{'⌂'}</span>
          <span style={navLabelStyle}>{t('sidebar.all')}</span>
        </button>

        <Link
          href="/topics/explore"
          className="os-nav-row"
          aria-current={exploreActive ? 'page' : undefined}
          onMouseEnter={() => setHoveredItem('explore-topics')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...navRowStyle(exploreActive),
            ...(hoveredItem === 'explore-topics' && !exploreActive ? { background: 'var(--surface-hover)' } : {}),
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: 20, flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span style={navLabelStyle}>{t('sidebar.exploreTopics')}</span>
          {exploreCount !== null && <span className="mono" style={navCountStyle}>{exploreCount}</span>}
        </Link>

        {!isGuest && (
          <button
            type="button"
            className="os-nav-row"
            aria-current={myTopicsActive ? 'page' : undefined}
            onClick={() => {
              if (onViewChange) {
                onViewChange('my');
              } else {
                window.location.href = '/topics?view=my';
              }
            }}
            onMouseEnter={() => setHoveredItem('my-topics')}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              ...navRowStyle(myTopicsActive),
              ...(hoveredItem === 'my-topics' && !myTopicsActive ? { background: 'var(--surface-hover)' } : {}),
            }}
          >
            <span style={navIconStyle(myTopicsActive)}>⭐</span>
            <span style={navLabelStyle}>{t('sidebar.myTopics')}</span>
          </button>
        )}

        <Link
          href="/recorded"
          className="os-nav-row"
          aria-current={recordedActive ? 'page' : undefined}
          onMouseEnter={() => setHoveredItem('on-chain-records')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...navRowStyle(recordedActive),
            ...(hoveredItem === 'on-chain-records' && !recordedActive ? { background: 'var(--surface-hover)' } : {}),
          }}
        >
          <span style={navIconStyle(recordedActive)}>⛓</span>
          <span style={navLabelStyle}>{t('sidebar.onChainRecords.title')}</span>
        </Link>
      </NavGroup>

      {/* Conversations — Chat. Only rendered at all when there is a chat for
          the current user to open (never for guests) — a group whose sole
          row is hidden would render an empty, pointless disclosure. */}
      {onOpenChat && (
        <NavGroup id="conversations" label={t('sidebar.conversations')} open={groupState.conversations} onToggle={toggleGroup}>
          <button
            type="button"
            onClick={onOpenChat}
            data-testid="left-nav-chat"
            className="os-nav-row"
            onMouseEnter={() => setHoveredItem('open-chat')}
            onMouseLeave={() => setHoveredItem(null)}
            style={{
              ...navRowStyle(false),
              ...(hoveredItem === 'open-chat' ? { background: 'var(--surface-hover)' } : {}),
            }}
          >
            <span style={navIconStyle(false)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </span>
            <span style={navLabelStyle}>{t('sidebar.chat')}</span>
            {chatBadge !== null && <span style={navBadgeStyle}>{chatBadge}</span>}
          </button>
        </NavGroup>
      )}

      {/* Categories with popular topics */}
      <NavGroup id="categories" label={t('sidebar.categories')} open={groupState.categories} onToggle={toggleGroup}>
        {categories.map((cat) => {
          const isActive = activeCategory === cat.slug;
          const catTopics = (topicsByCategory[cat.slug] ?? []).slice(0, 3);
          const isExpanded = expandedCategories.has(cat.slug);

          const selectCategory = () => {
            if (onCategorySelect) {
              onCategorySelect(cat.slug);
            } else {
              router.push(`/topics?category=${encodeURIComponent(cat.slug)}`);
            }
          };

          return (
            <div key={cat.id}>
              {/* This row is a <div role="button">, not a native <button>,
                  because it contains a second, independently-clickable
                  <button> (the expand/collapse chevron below) — nesting a
                  <button> inside a <button> is invalid HTML and previously
                  caused a real hydration-mismatch warning once a category
                  had topics (React refuses to nest interactive content). */}
              <div
                role="button"
                tabIndex={0}
                className="os-nav-row"
                aria-current={isActive ? 'page' : undefined}
                onClick={selectCategory}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectCategory();
                  }
                }}
                onMouseEnter={() => setHoveredItem(cat.id)}
                onMouseLeave={() => setHoveredItem(null)}
                style={{
                  ...navRowStyle(isActive),
                  ...(hoveredItem === cat.id && !isActive
                    ? { background: 'var(--surface-hover)' }
                    : {}),
                }}
              >
                <span style={navIconStyle(isActive)}>{cat.icon}</span>
                <span style={navLabelStyle}>{cat.name}</span>
                {catTopics.length > 0 && (
                  <button
                    className="os-nav-row"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      toggleCategory(cat.slug);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: 'var(--text-label)',
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                    aria-label={isExpanded ? t('sidebar.collapse') : t('sidebar.expand')}
                  >
                    <Chevron expanded={isExpanded} />
                  </button>
                )}
              </div>

              {/* Popular topics under this category */}
              {isExpanded && catTopics.length > 0 && (
                <div style={{ paddingLeft: 20, marginBottom: 4 }}>
                  {catTopics.map((topic) => (
                    <Link
                      key={topic.id}
                      href={`/topics/${topic.id}`}
                      className="os-nav-row"
                      aria-current={activeTopicId === topic.id ? 'page' : undefined}
                      onMouseEnter={() => setHoveredItem(`cat-topic-${topic.id}`)}
                      onMouseLeave={() => setHoveredItem(null)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 8px',
                        borderRadius: 6,
                        textDecoration: 'none',
                        fontSize: 12,
                        color: activeTopicId === topic.id ? 'var(--accent)' : 'var(--color-text-secondary)',
                        background: hoveredItem === `cat-topic-${topic.id}`
                          ? 'var(--surface-hover)'
                          : activeTopicId === topic.id
                          ? 'var(--color-brand-primary-muted)'
                          : 'transparent',
                        transition: 'background 0.12s, color 0.12s',
                      }}
                    >
                      <TopicAvatar name={topic.title} image={topic.image} size={16} />
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap' as const,
                        flex: 1,
                        minWidth: 0,
                      }}>
                        {topic.title}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </NavGroup>

      {/* Popular Tags */}
      {tags.length > 0 && (
        <div style={sidebarCardStyle}>
          <div className="os-label" style={sectionHeadingStyle}>{t('sidebar.popularTags')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((tag) => {
              const isActive = activeTag === tag.slug;
              return (
                <button
                  key={tag.id}
                  onClick={() => {
                    const newSlug = isActive ? null : tag.slug;
                    if (onTagSelect) {
                      onTagSelect(newSlug);
                    } else {
                      router.push(newSlug ? `/topics?tag=${encodeURIComponent(newSlug)}` : '/topics');
                    }
                  }}
                  onMouseEnter={() => setHoveredTag(tag.id)}
                  onMouseLeave={() => setHoveredTag(null)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12,
                    padding: '3px 10px',
                    borderRadius: 9999,
                    // Active and hover share the brand tint; the border is what
                    // separates them (there is one brand-muted step, not two).
                    background: isActive || hoveredTag === tag.id
                      ? 'var(--color-brand-primary-muted)'
                      : 'var(--color-bg-tertiary)',
                    border: isActive
                      ? '1px solid var(--color-brand-primary)'
                      : '1px solid var(--color-border-default)',
                    color: isActive
                      ? 'var(--accent)'
                      : hoveredTag === tag.id
                      ? 'var(--accent)'
                      : 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    fontFamily: 'inherit',
                  }}
                >
                  <span>#{tag.name}</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-label)',
                    color: isActive ? 'var(--accent)' : 'var(--color-text-tertiary)',
                  }}>
                    {tag.postCount}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Community Stats */}
      <div style={sidebarCardStyle}>
        <div className="os-label" style={sectionHeadingStyle}>{t('sidebar.community')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { id: 'topics', labelKey: 'sidebar.stats.topics', value: stats.totalTopics },
            { id: 'members', labelKey: 'sidebar.stats.members', value: stats.totalMembers },
          ].map(({ id, labelKey, value }) => (
            <div
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13,
                color: 'var(--muted)',
                padding: '0 4px',
              }}
            >
              <span>{t(labelKey)}</span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--foreground)',
                fontSize: 13,
              }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>

    </nav>
  );
}
