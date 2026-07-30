'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import TopicAvatar from '@/components/TopicAvatar';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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
}

// ─── Fallback categories ─────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'base-layer2', name: 'Base & Layer 2', slug: 'base-layer2', icon: '\uD83D\uDD35', sortOrder: 1 },
  { id: 'defi-trading', name: 'DeFi & Trading', slug: 'defi-trading', icon: '\uD83D\uDCC8', sortOrder: 2 },
  { id: 'nft-gaming', name: 'NFT & Gaming', slug: 'nft-gaming', icon: '\uD83C\uDFAE', sortOrder: 3 },
  { id: 'privacy-zk', name: 'Privacy & ZK', slug: 'privacy-zk', icon: '\uD83D\uDD10', sortOrder: 4 },
  { id: 'development', name: 'Development', slug: 'development', icon: '\uD83D\uDCBB', sortOrder: 5 },
  { id: 'governance', name: 'Governance', slug: 'governance', icon: '\uD83C\uDFDB\uFE0F', sortOrder: 6 },
  { id: 'free-talk', name: 'Free Talk', slug: 'free-talk', icon: '\uD83D\uDCAC', sortOrder: 7 },
  { id: 'announcements', name: 'Announcements', slug: 'announcements', icon: '\uD83D\uDCE2', sortOrder: 8 },
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

function sidebarItemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    color: active ? 'var(--accent)' : 'var(--foreground)',
    background: active ? 'var(--color-brand-primary-muted)' : 'transparent',
    transition: 'background 0.12s, color 0.12s',
    textDecoration: 'none',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    fontWeight: active ? 600 : 400,
    lineHeight: 1.4,
  };
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
          onMouseEnter={() => setHoveredItem('start-topic')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--foreground)',
            background: hoveredItem === 'start-topic' ? 'var(--surface-hover)' : 'transparent',
            transition: 'background 0.12s, color 0.12s',
            marginBottom: 12,
          }}
        >
          <span style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            fontSize: 16,
            color: 'var(--muted)',
          }}>
            +
          </span>
          <span>{t('sidebar.startTopic')}</span>
        </Link>
      )}

      {/* Chat -- direct entry point into the chat rail, landed on the room
          list (a topic-specific jump also exists on the topic page's right
          sidebar). Hidden for guests, same gating as the header's own chat
          toggle -- there is no chat for a guest to open. */}
      {onOpenChat && (
        <button
          type="button"
          onClick={onOpenChat}
          data-testid="left-nav-chat"
          onMouseEnter={() => setHoveredItem('open-chat')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            borderRadius: 8,
            border: 'none',
            width: '100%',
            textAlign: 'left' as const,
            fontFamily: 'inherit',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--foreground)',
            background: hoveredItem === 'open-chat' ? 'var(--surface-hover)' : 'transparent',
            transition: 'background 0.12s, color 0.12s',
            marginBottom: 12,
            cursor: 'pointer',
          }}
        >
          <span style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            color: 'var(--muted)',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </span>
          <span>{t('sidebar.chat')}</span>
        </button>
      )}

      {/* Categories with popular topics */}
      <div style={sidebarCardStyle}>
        <div className="os-label" style={sectionHeadingStyle}>{t('sidebar.categories')}</div>
        {/* All / Home item */}
        <button
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
            ...sidebarItemStyle(viewMode !== 'my' && !activeCategory && !activeTopicId),
            ...(hoveredItem === 'all' && !(viewMode !== 'my' && !activeCategory && !activeTopicId)
              ? { background: 'var(--surface-hover)' }
              : {}),
          }}
        >
          <span style={{ fontSize: 15, width: 20, textAlign: 'center' as const }}>
            {'\u2302'}
          </span>
          <span>{t('sidebar.all')}</span>
        </button>

        {/* My Topics — only visible when logged in */}
        {!isGuest && (
          <button
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
              ...sidebarItemStyle(viewMode === 'my'),
              ...(hoveredItem === 'my-topics' && viewMode !== 'my' ? { background: 'var(--surface-hover)' } : {}),
            }}
          >
            <span style={{ fontSize: 15, width: 20, textAlign: 'center' as const }}>⭐</span>
            <span>{t('sidebar.myTopics')}</span>
          </button>
        )}

        {/* Explore Topics */}
        <Link
          href="/topics/explore"
          onMouseEnter={() => setHoveredItem('explore-topics')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...sidebarItemStyle(pathname === '/topics/explore'),
            ...(hoveredItem === 'explore-topics' && pathname !== '/topics/explore'
              ? { background: 'var(--surface-hover)' }
              : {}),
            textDecoration: 'none',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: 20, textAlign: 'center' as const, flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>{t('sidebar.exploreTopics')}</span>
        </Link>

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
                  ...sidebarItemStyle(isActive),
                  ...(hoveredItem === cat.id && !isActive
                    ? { background: 'var(--surface-hover)' }
                    : {}),
                }}
              >
                <span style={{ fontSize: 15, width: 20, textAlign: 'center' as const }}>
                  {cat.icon}
                </span>
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  flex: 1,
                  minWidth: 0,
                }}>
                  {cat.name}
                </span>
                {catTopics.length > 0 && (
                  <button
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
                      transition: 'transform 0.15s',
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      flexShrink: 0,
                    }}
                    aria-label={isExpanded ? t('sidebar.collapse') : t('sidebar.expand')}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
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
      </div>

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

      {/* On-Chain Records — the quietest card in the rail. The violet it used
          to be tinted with is in no palette, so it read as a highlight in dark
          mode and vanished in light; on-chain is an outline, never a fill. */}
      <div style={sidebarCardStyle}>
        <div className="os-label" style={{
          ...sectionHeadingStyle,
          color: 'var(--color-text-tertiary)',
        }}>
          {t('sidebar.onChainRecords.title')}
        </div>
        <p style={{
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          margin: '0 0 10px',
          lineHeight: 1.5,
        }}>
          {t('sidebar.onChainRecords.body')}
        </p>
        <Link
          href="/recorded"
          style={{
            fontSize: 13,
            fontWeight: 600,
            // A link is an action, so it keeps the action color even though the
            // card around it is deliberately quiet.
            color: 'var(--color-brand-primary)',
            textDecoration: 'none',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.8'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
        >
          {t('sidebar.onChainRecords.cta')} {'\u2192'}
        </Link>
      </div>

    </nav>
  );
}
