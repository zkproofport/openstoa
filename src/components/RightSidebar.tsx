'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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
  /** Jumps the chat rail straight to THIS topic's room (as opposed to the
   *  generic list the left-nav "Chat" entry lands on). Only ever passed
   *  alongside `topicId`/`topicTitle` -- see `CommunityLayout.tsx`. */
  onOpenChat?: () => void;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sidebarCardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--space-4)',
  marginBottom: 'var(--space-3)',
};

// Font-size/weight/family + the language-conditional uppercase+tracking come
// from the `.os-label` utility class (globals.css), same idiom as
// `LeftSidebar.tsx` — apply that class alongside this style object at each
// usage site below.
const sectionHeadingStyle: React.CSSProperties = {
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

/**
 * Purely informational sidebar — topic summary + a cross-topic "Recent Posts"
 * feed. Live chat used to be rendered inline here (docked column / expand-to-
 * sidebar / maximize-modal); that entire system moved to `ChatRail.tsx`,
 * mounted once at the `CommunityLayout` level and independent of any single
 * topic page, so this component no longer imports `ChatPanel` at all.
 */
export default function RightSidebar({
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
  onOpenChat,
}: RightSidebarProps) {
  const { t } = useTranslation();
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [hoveredPost, setHoveredPost] = useState<string | null>(null);

  // Fetch recent posts from feed endpoint (falls back to topics endpoint)
  useEffect(() => {
    // Try the feed endpoint first
    apiFetch('/api/feed?sort=new&limit=6')
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
        apiFetch('/api/topics?view=all&sort=active&limit=6')
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
      {/* Topic-specific info (when on a topic page). */}
      {topicId && topicTitle && (
        <div style={sidebarCardStyle}>
          <div className="os-label" style={sectionHeadingStyle}>{t('rightSidebar.aboutTopic')}</div>
          <div style={{
            fontSize: 'var(--text-body-lg)',
            fontWeight: 700,
            color: 'var(--foreground)',
            marginBottom: 6,
            letterSpacing: '-0.01em',
          }}>
            {topicTitle}
          </div>
          {topicDescription && (
            <p style={{
              fontSize: 'var(--text-caption)',
              color: 'var(--muted)',
              margin: '0 0 var(--space-2)',
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
              fontSize: 'var(--text-caption)',
              color: 'var(--muted)',
            }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--foreground)',
              }}>
                {topicMemberCount}
              </span>
              <span>{topicMemberCount === 1 ? t('rightSidebar.member') : t('rightSidebar.members')}</span>
            </div>
          )}
          {/*
            THE "Open topic chat" ENTRY IS GONE — the fourth of four.
            Chat is not available on the web. A browser cannot read a room: the
            keys live on the phone and never leave it. What a browser COULD do
            from here was join the group, advance an epoch, and post ciphertext
            nobody would ever open — damage rather than nothing. The bottom tab,
            the header toggle and the left-nav group went with it; this one is
            the easiest to miss because it only appears on a topic page.
            See `ChatOnMobileOnly`.
          */}
        </div>
      )}

      {/* Recent Posts */}
      <div style={sidebarCardStyle}>
        <div className="os-label" style={sectionHeadingStyle}>{t('rightSidebar.recentPosts')}</div>
        {recentPosts.length === 0 ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)', margin: 0 }}>{t('rightSidebar.noRecentPosts')}</p>
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
                  padding: 'var(--space-3) var(--space-3)',
                  borderRadius: 8,
                  background: hoveredPost === post.id ? 'var(--surface-hover)' : 'transparent',
                  transition: 'background 0.12s',
                }}
              >
                {/* Topic name — bumped 11px -> 13px (--text-caption): below the
                    12px floor and not an uppercase Latin label, and this is a
                    user-authored (possibly Korean) topic title, not a fixed
                    decorative string. */}
                <div style={{
                  fontSize: 'var(--text-caption)',
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
                  fontSize: 'var(--text-caption)',
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

                {/* Content preview — kept at --text-caption (13px), NOT bumped
                    to the 16px Korean-prose floor: this is a 2-line clamped
                    excerpt inside a compact sidebar card, sized to sit below
                    the post title (also 13px) in the visual hierarchy. Going
                    to 16px would make the excerpt read larger than its own
                    title — a real layout regression, not a like-for-like
                    token swap. Still bumped up from the original 12px (below
                    the floor) to the same 13px as its siblings. */}
                {post.content && (
                  <div style={{
                    fontSize: 'var(--text-caption)',
                    color: 'var(--color-text-secondary)',
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

                {/* Time — relative-time string is Latin/numeric only (e.g.
                    "2h ago"), so the 12px label floor (not the Korean-prose
                    floor) applies. */}
                <div style={{
                  fontSize: 'var(--text-label)',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-tertiary)',
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
