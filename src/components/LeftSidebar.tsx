'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import TopicAvatar from '@/components/TopicAvatar';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  sortOrder: number;
}

interface JoinedTopic {
  id: string;
  title: string;
  image?: string | null;
}

interface LeftSidebarProps {
  isGuest: boolean;
  sessionChecked: boolean;
  activeCategory?: string | null;
  onCategorySelect?: (slug: string | null) => void;
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
}: LeftSidebarProps) {
  const pathname = usePathname();
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [myTopics, setMyTopics] = useState<JoinedTopic[]>([]);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  // Fetch categories from API, fall back to defaults
  useEffect(() => {
    fetch('/api/categories')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.categories && data.categories.length > 0) {
          setCategories(data.categories);
        }
      })
      .catch(() => {
        // Keep defaults
      });
  }, []);

  // Fetch joined topics for logged-in users
  useEffect(() => {
    if (isGuest || !sessionChecked) return;
    fetch('/api/topics')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.topics) {
          setMyTopics(data.topics.slice(0, 10));
        }
      })
      .catch(() => {});
  }, [isGuest, sessionChecked]);

  // Determine if we're on a specific topic page
  const topicMatch = pathname.match(/^\/topics\/([^/]+)/);
  const activeTopicId = topicMatch ? topicMatch[1] : null;

  return (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Categories */}
      <div style={sidebarCardStyle}>
        <div style={sectionHeadingStyle}>Categories</div>
        {/* All Topics item */}
        <button
          onClick={() => onCategorySelect?.(null)}
          onMouseEnter={() => setHoveredItem('all')}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            ...sidebarItemStyle(!activeCategory && !activeTopicId),
            ...(hoveredItem === 'all' && !activeCategory && activeTopicId !== null
              ? { background: 'var(--surface-hover)' }
              : {}),
          }}
        >
          <span style={{ fontSize: 15, width: 20, textAlign: 'center' as const }}>
            {'\u2302'}
          </span>
          <span>All Topics</span>
        </button>

        {categories.map((cat) => {
          const isActive = activeCategory === cat.slug;
          return (
            <button
              key={cat.id}
              onClick={() => onCategorySelect?.(cat.slug)}
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {cat.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* My Topics (authenticated only) */}
      {!isGuest && sessionChecked && myTopics.length > 0 && (
        <div style={sidebarCardStyle}>
          <div style={sectionHeadingStyle}>My Topics</div>
          {myTopics.map((topic) => {
            const isActive = activeTopicId === topic.id;
            return (
              <Link
                key={topic.id}
                href={`/topics/${topic.id}`}
                onMouseEnter={() => setHoveredItem(`topic-${topic.id}`)}
                onMouseLeave={() => setHoveredItem(null)}
                style={{
                  ...sidebarItemStyle(isActive),
                  ...(hoveredItem === `topic-${topic.id}` && !isActive
                    ? { background: 'var(--surface-hover)' }
                    : {}),
                }}
              >
                <TopicAvatar name={topic.title} image={topic.image} size={22} />
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
            );
          })}
        </div>
      )}

      {/* Create Topic button (authenticated only) */}
      {!isGuest && sessionChecked && (
        <Link
          href="/topics/new"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: 'var(--accent)',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: 10,
            padding: '10px 16px',
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            transition: 'opacity 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.boxShadow = '0 0 20px rgba(120,140,255,0.2)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.boxShadow = 'none';
          }}
        >
          + Create Topic
        </Link>
      )}
    </nav>
  );
}
