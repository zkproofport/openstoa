'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import TopicAvatar from '@/components/TopicAvatar';

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
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--muted)',
  marginBottom: 10,
  padding: '0 4px',
  fontFamily: 'var(--font-mono)',
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
    background: active ? 'rgba(120,140,255,0.1)' : 'transparent',
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
}: LeftSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
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
            placeholder="Search topics..."
            value={topicSearch}
            onChange={(e) => setTopicSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px 8px 32px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--foreground)',
              fontSize: 13,
              outline: 'none',
              fontFamily: 'var(--font-mono)',
              transition: 'border-color 0.15s',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.3)'; }}
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
          <span>Start a Topic</span>
        </Link>
      )}

      {/* Categories with popular topics */}
      <div style={sidebarCardStyle}>
        <div style={sectionHeadingStyle}>Categories</div>
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
          <span>All</span>
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
            <span>My Topics</span>
          </button>
        )}

        {categories.map((cat) => {
          const isActive = activeCategory === cat.slug;
          const catTopics = (topicsByCategory[cat.slug] ?? []).slice(0, 3);
          const isExpanded = expandedCategories.has(cat.slug);

          return (
            <div key={cat.id}>
              <button
                onClick={() => {
                  if (onCategorySelect) {
                    onCategorySelect(cat.slug);
                  } else {
                    router.push(`/topics?category=${encodeURIComponent(cat.slug)}`);
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
                      fontSize: 10,
                      lineHeight: 1,
                      transition: 'transform 0.15s',
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      flexShrink: 0,
                    }}
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                )}
              </button>

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
                        color: activeTopicId === topic.id ? 'var(--accent)' : '#9ca3af',
                        background: hoveredItem === `cat-topic-${topic.id}`
                          ? 'var(--surface-hover)'
                          : activeTopicId === topic.id
                          ? 'rgba(120,140,255,0.08)'
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
          <div style={sectionHeadingStyle}>Popular Tags</div>
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
                    background: isActive
                      ? 'rgba(120,140,255,0.18)'
                      : hoveredTag === tag.id
                      ? 'rgba(120,140,255,0.12)'
                      : 'rgba(255,255,255,0.04)',
                    border: isActive
                      ? '1px solid rgba(120,140,255,0.35)'
                      : '1px solid rgba(255,255,255,0.08)',
                    color: isActive
                      ? 'var(--accent)'
                      : hoveredTag === tag.id
                      ? 'var(--accent)'
                      : '#9ca3af',
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    fontFamily: 'inherit',
                  }}
                >
                  <span>#{tag.name}</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: isActive ? 'var(--accent)' : '#4b5563',
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
        <div style={sectionHeadingStyle}>Community</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { label: 'Topics', value: stats.totalTopics },
            { label: 'Members', value: stats.totalMembers },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13,
                color: 'var(--muted)',
                padding: '0 4px',
              }}
            >
              <span>{label}</span>
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

      {/* On-Chain Records */}
      <div style={{
        ...sidebarCardStyle,
        background: 'rgba(139,92,246,0.04)',
        border: '1px solid rgba(139,92,246,0.12)',
      }}>
        <div style={{
          ...sectionHeadingStyle,
          color: '#a78bfa',
        }}>
          On-Chain Records
        </div>
        <p style={{
          fontSize: 13,
          color: '#6b7280',
          margin: '0 0 10px',
          lineHeight: 1.5,
        }}>
          Posts recorded on Base are permanently preserved on-chain.
        </p>
        <Link
          href="/recorded"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#a78bfa',
            textDecoration: 'none',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.8'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
        >
          View recorded posts {'\u2192'}
        </Link>
      </div>

    </nav>
  );
}
