'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/utils';
import ChatPanel from '@/components/ChatPanel';
import { createPortal } from 'react-dom';

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
  isGuest?: boolean;
  isMember?: boolean;
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

// ─── Expanded chat overlay ────────────────────────────────────────────────────

function ExpandedChatOverlay({
  topicId,
  isGuest,
  isMember,
  onClose,
}: {
  topicId: string;
  isGuest: boolean;
  isMember: boolean;
  onClose: () => void;
}) {
  // Close on Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 95,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'chatOverlayFadeIn 0.18s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 480,
          height: 600,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
      >
        {/* Overlay header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15 }}>💬</span>
            <span style={{
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.08em',
              color: 'var(--foreground)',
            }}>Live Chat</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close expanded chat"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              color: 'var(--muted)',
              cursor: 'pointer',
              width: 30,
              height: 30,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {/* Chat fills remaining space */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ChatPanel topicId={topicId} isGuest={isGuest} isMember={isMember} fullHeight />
        </div>
      </div>
      <style>{`
        @keyframes chatOverlayFadeIn {
          from { opacity: 0; transform: scale(0.97); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function RightSidebar({
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
  isGuest,
  isMember,
}: RightSidebarProps) {
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [hoveredPost, setHoveredPost] = useState<string | null>(null);
  const [chatExpanded, setChatExpanded] = useState(false);

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

      {/* Live Chat */}
      {topicId && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          {/* Expand button — desktop only (hidden via CSS on mobile) */}
          <button
            className="chat-expand-btn"
            onClick={() => setChatExpanded(true)}
            aria-label="Expand chat"
            title="Expand chat"
            style={{
              position: 'absolute',
              top: 8,
              right: 10,
              zIndex: 2,
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            {/* ↗ expand icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <ChatPanel topicId={topicId} isGuest={isGuest ?? true} isMember={isMember ?? false} />
          {chatExpanded && (
            <ExpandedChatOverlay
              topicId={topicId}
              isGuest={isGuest ?? true}
              isMember={isMember ?? false}
              onClose={() => setChatExpanded(false)}
            />
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
