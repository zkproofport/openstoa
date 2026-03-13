'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RecentPost {
  id: string;
  title: string;
  authorNickname: string;
  createdAt: string;
  topicId: string;
  topicTitle: string;
}

interface Tag {
  id: string;
  name: string;
  slug: string;
  postCount: number;
}

interface CommunityStats {
  totalTopics: number;
  totalPosts: number;
  totalMembers: number;
}

interface RightSidebarProps {
  /** If on a specific topic page, pass the topicId for context */
  topicId?: string;
  topicTitle?: string;
  topicDescription?: string;
  topicMemberCount?: number;
}

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
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function RightSidebar({
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
}: RightSidebarProps) {
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [stats, setStats] = useState<CommunityStats>({ totalTopics: 0, totalPosts: 0, totalMembers: 0 });
  const [hoveredPost, setHoveredPost] = useState<string | null>(null);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);

  // Fetch recent activity from the "active" sorted topics endpoint
  useEffect(() => {
    fetch('/api/topics?view=all&sort=active&limit=5')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.topics) {
          // Map topics into "recent" items — using topic-level data as proxy
          const mapped: RecentPost[] = data.topics.slice(0, 5).map((t: {
            id: string;
            title: string;
            memberCount?: number;
            createdAt: string;
            latestPostTitle?: string;
            latestPostAuthor?: string;
            latestPostId?: string;
            latestPostAt?: string;
          }) => ({
            id: t.latestPostId ?? t.id,
            title: t.latestPostTitle ?? t.title,
            authorNickname: t.latestPostAuthor ?? '',
            createdAt: t.latestPostAt ?? t.createdAt,
            topicId: t.id,
            topicTitle: t.title,
          }));
          setRecentPosts(mapped);

          // Derive stats
          setStats((prev) => ({
            ...prev,
            totalTopics: data.topics.length,
            totalMembers: data.topics.reduce(
              (sum: number, t: { memberCount?: number }) => sum + (t.memberCount ?? 0),
              0,
            ),
          }));
        }
      })
      .catch(() => {});
  }, []);

  // Fetch popular tags
  useEffect(() => {
    const tagUrl = topicId ? `/api/tags?topicId=${topicId}` : '/api/tags';
    fetch(tagUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.tags) {
          setTags(data.tags.slice(0, 12));
        }
      })
      .catch(() => {});
  }, [topicId]);

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Topic-specific info (when on a topic page) */}
      {topicId && topicTitle && (
        <div style={sidebarCardStyle}>
          <div style={sectionHeadingStyle}>About this topic</div>
          <div style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--foreground)',
            marginBottom: 6,
            letterSpacing: '-0.01em',
          }}>
            {topicTitle}
          </div>
          {topicDescription && (
            <p style={{
              fontSize: 13,
              color: 'var(--muted)',
              margin: '0 0 10px',
              lineHeight: 1.5,
            }}>
              {topicDescription}
            </p>
          )}
          {topicMemberCount != null && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              color: 'var(--muted)',
            }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--foreground)',
              }}>
                {topicMemberCount}
              </span>
              <span>member{topicMemberCount !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}

      {/* Recent Activity */}
      <div style={sidebarCardStyle}>
        <div style={sectionHeadingStyle}>Recent Activity</div>
        {recentPosts.length === 0 ? (
          <p style={{ fontSize: 13, color: '#4b5563', margin: 0 }}>No recent activity</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recentPosts.map((post) => (
              <Link
                key={post.id}
                href={`/topics/${post.topicId}`}
                onMouseEnter={() => setHoveredPost(post.id)}
                onMouseLeave={() => setHoveredPost(null)}
                style={{
                  display: 'block',
                  textDecoration: 'none',
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: hoveredPost === post.id ? 'var(--surface-hover)' : 'transparent',
                  transition: 'background 0.12s',
                }}
              >
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--foreground)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                  marginBottom: 3,
                }}>
                  {post.title}
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: '#4b5563',
                }}>
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap' as const,
                    maxWidth: 100,
                  }}>
                    {post.topicTitle}
                  </span>
                  <span>{'\u00B7'}</span>
                  <span>{relativeTime(post.createdAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

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

      {/* Popular Tags */}
      {tags.length > 0 && (
        <div style={sidebarCardStyle}>
          <div style={sectionHeadingStyle}>Popular Tags</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((tag) => (
              <span
                key={tag.id}
                onMouseEnter={() => setHoveredTag(tag.id)}
                onMouseLeave={() => setHoveredTag(null)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  padding: '3px 10px',
                  borderRadius: 9999,
                  background: hoveredTag === tag.id
                    ? 'rgba(120,140,255,0.12)'
                    : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: hoveredTag === tag.id ? 'var(--accent)' : '#9ca3af',
                  cursor: 'default',
                  transition: 'all 0.12s',
                }}
              >
                <span>#{tag.name}</span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: '#4b5563',
                }}>
                  {tag.postCount}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* On-Chain Records accent */}
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
    </aside>
  );
}
