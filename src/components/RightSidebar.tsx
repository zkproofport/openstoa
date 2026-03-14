'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RecentPost {
  id: string;
  title: string;
  content: string;
  authorNickname: string;
  createdAt: string;
  topicId: string;
  topicTitle: string;
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
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--muted)',
  marginBottom: 10,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip HTML tags and truncate to maxLen characters */
function stripAndTruncate(html: string, maxLen: number): string {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '...';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function RightSidebar({
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
}: RightSidebarProps) {
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [hoveredPost, setHoveredPost] = useState<string | null>(null);

  // Fetch recent posts from feed endpoint (falls back to topics endpoint)
  useEffect(() => {
    // Try the feed endpoint first
    fetch('/api/feed?sort=new&limit=6')
      .then((r) => {
        if (!r.ok) throw new Error('feed not available');
        return r.json();
      })
      .then((data) => {
        if (data?.posts) {
          setRecentPosts(data.posts.map((p: {
            id: string;
            title: string;
            content?: string;
            authorNickname?: string;
            createdAt: string;
            topicId: string;
            topicTitle?: string;
          }) => ({
            id: p.id,
            title: p.title,
            content: p.content ?? '',
            authorNickname: p.authorNickname ?? '',
            createdAt: p.createdAt,
            topicId: p.topicId,
            topicTitle: p.topicTitle ?? '',
          })));
        }
      })
      .catch(() => {
        // Fallback: fetch from topics active endpoint
        fetch('/api/topics?view=all&sort=active&limit=6')
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.topics) {
              const mapped: RecentPost[] = data.topics.slice(0, 6).map((t: {
                id: string;
                title: string;
                createdAt: string;
                latestPostTitle?: string;
                latestPostAuthor?: string;
                latestPostId?: string;
                latestPostAt?: string;
                latestPostContent?: string;
              }) => ({
                id: t.latestPostId ?? t.id,
                title: t.latestPostTitle ?? t.title,
                content: t.latestPostContent ?? '',
                authorNickname: t.latestPostAuthor ?? '',
                createdAt: t.latestPostAt ?? t.createdAt,
                topicId: t.id,
                topicTitle: t.title,
              }));
              setRecentPosts(mapped);
            }
          })
          .catch(() => {});
      });
  }, []);

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

      {/* Recent Posts */}
      <div style={sidebarCardStyle}>
        <div style={sectionHeadingStyle}>Recent Posts</div>
        {recentPosts.length === 0 ? (
          <p style={{ fontSize: 13, color: '#4b5563', margin: 0 }}>No recent posts</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recentPosts.map((post) => (
              <Link
                key={post.id}
                href={`/topics/${post.topicId}/posts/${post.id}`}
                onMouseEnter={() => setHoveredPost(post.id)}
                onMouseLeave={() => setHoveredPost(null)}
                style={{
                  display: 'block',
                  textDecoration: 'none',
                  padding: '10px 10px',
                  borderRadius: 8,
                  background: hoveredPost === post.id ? 'var(--surface-hover)' : 'transparent',
                  transition: 'background 0.12s',
                }}
              >
                {/* Topic name */}
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--accent)',
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  marginBottom: 3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                }}>
                  t/{post.topicTitle}
                </div>

                {/* Post title */}
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

                {/* Content preview */}
                {post.content && (
                  <div style={{
                    fontSize: 12,
                    color: '#6b7280',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    marginBottom: 4,
                  }}>
                    {stripAndTruncate(post.content, 80)}
                  </div>
                )}

                {/* Time */}
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: '#4b5563',
                }}>
                  {relativeTime(post.createdAt)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
