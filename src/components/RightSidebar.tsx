'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/utils';
import ChatPanel, { type ChatMode } from '@/components/ChatPanel';
import { useMediaQuery, DESKTOP_CHAT_QUERY } from '@/hooks/useMediaQuery';
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
  /** Dedicated full-height chat column (topic page, signed-in member).
   *  The chat fills the remaining column height instead of sitting in a
   *  fixed-height card with dead space underneath. */
  chatColumn?: boolean;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sidebarCardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
};

/** Sticky header height — keep in sync with CommunityLayout's HEADER_HEIGHT. */
const HEADER_HEIGHT = 49;

/**
 * Which expand style the user reached for last (`sidebar` | `modal`). It is a
 * *preference*, never a restored state: every page load starts in the docked
 * panel, exactly as it does today. Absent/unknown value → `sidebar`.
 */
const CHAT_MODE_KEY = 'openstoa:chat-mode';

type ExpandMode = Exclude<ChatMode, 'docked'>;

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

// ─── Expanded chat shells ─────────────────────────────────────────────────────

/**
 * Chrome only — a tall column pinned to the page's right gutter, wider than the
 * docked chat column and sized to cover it completely. Deliberately NOT modal:
 * no backdrop, no scroll lock, no focus trap, so the page beside it stays
 * readable and clickable — that is the whole point of choosing this over the
 * modal.
 *
 * Like the modal shell it only provides an empty slot; the parent moves the
 * single live ChatPanel node into it.
 */
function SidebarChatShell({
  slotRef,
  onClose,
}: {
  slotRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape returns to the docked panel, same as the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reparenting the panel node blurs whatever was focused inside it, so put
  // focus on the new container instead of dropping it on <body>.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // The floating compose button on the topic page is positioned relative to the
  // docked chat column; nudge it clear of this wider overlay while it is open.
  useEffect(() => {
    document.body.classList.add('chat-sidebar-open');
    return () => document.body.classList.remove('chat-sidebar-open');
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      role="region"
      aria-label="Live chat side panel"
      tabIndex={-1}
      style={{
        position: 'fixed',
        top: HEADER_HEIGHT + 12,
        // Geometry vars come from CommunityLayout, which owns the page shell
        // measurements this panel has to line up with.
        right: 'var(--chat-overlay-right)',
        bottom: 12,
        width: 'var(--chat-overlay-w)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        outline: 'none',
        zIndex: 90,
        boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        animation: 'chatSidebarSlideIn 0.18s ease',
      }}
    >
      {/* Slot — the docked ChatPanel node is relocated here. It brings its own
          header (topic title, presence, the two expand controls). */}
      <div
        ref={slotRef}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      />
      <style>{`
        @keyframes chatSidebarSlideIn {
          from { opacity: 0; transform: translateX(18px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

/**
 * Chrome only — backdrop plus a near-fullscreen dialog with an empty slot.
 * The live ChatPanel DOM node is moved into `slotRef` by the parent, so
 * maximizing never mounts a second panel: the socket, the decrypted message
 * list and the composer draft all survive the transition.
 */
function MaximizedChatShell({
  slotRef,
  onClose,
}: {
  slotRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the dialog so it is never left behind the backdrop.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Lock body scroll while overlay is open
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.62)',
        zIndex: 95,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'chatOverlayFadeIn 0.18s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Live chat"
        tabIndex={-1}
        style={{
          width: '100%',
          maxWidth: 1160,
          height: '100%',
          maxHeight: 'none',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          outline: 'none',
          boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
        }}
      >
        {/* Slot — the docked ChatPanel node is relocated here while maximized.
            It brings its own header (topic title, presence, restore button). */}
        <div
          ref={slotRef}
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        />
      </div>
      <style>{`
        @keyframes chatOverlayFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
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
  chatColumn,
}: RightSidebarProps) {
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [hoveredPost, setHoveredPost] = useState<string | null>(null);
  // Always docked on load — the first screen must stay exactly as it is today.
  // Expanding is an explicit act; nothing here is ever restored from storage.
  const [chatMode, setChatMode] = useState<ChatMode>('docked');
  // The expand style the user last used. Persisted, but it only decides which
  // segment regains focus after docking — never which mode the page opens in.
  const [preferredExpand, setPreferredExpand] = useState<ExpandMode>('sidebar');
  // Only the visible surface owns the live chat session — see DESKTOP_CHAT_QUERY.
  const isDesktop = useMediaQuery(DESKTOP_CHAT_QUERY);
  // An expanded mode only survives where there is a live chat to expand:
  //  - below the desktop breakpoint the chat is the full-screen mobile sheet
  //    (CommunityLayout) and this sidebar is off screen, so an overlay here
  //    would float over the sheet — and mount a second panel;
  //  - off a topic page, or for guests/non-members, there is no panel at all.
  // Resizing down while expanded therefore falls back to docked, not to a
  // stranded overlay.
  const canExpand = Boolean(topicId && isMember && !isGuest);
  const effectiveMode: ChatMode = isDesktop && canExpand ? chatMode : 'docked';

  // A single detached host element carries the ChatPanel. It is appended to the
  // docked slot, the right-edge panel slot or the modal dialog slot, so the
  // panel is *moved* between the three, never re-created — no second
  // EventSource, no history refetch, no lost draft.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const dockSlotRef = useRef<HTMLDivElement>(null);
  const sidebarSlotRef = useRef<HTMLDivElement>(null);
  const maximizedSlotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.flex = '1';
    el.style.minHeight = '0';
    hostRef.current = el;
    setHost(el);
  }, []);

  // Read the stored preference once, on the client (reading localStorage during
  // render would desync the SSR markup from hydration). Note it feeds
  // `preferredExpand`, NOT `chatMode` — a reload never lands in an overlay.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CHAT_MODE_KEY);
      if (saved === 'sidebar' || saved === 'modal') setPreferredExpand(saved);
    } catch {
      // private mode / storage disabled — keep the default preference
    }
  }, []);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const target =
      effectiveMode === 'modal'
        ? maximizedSlotRef.current
        : effectiveMode === 'sidebar'
          ? sidebarSlotRef.current
          : dockSlotRef.current;
    if (target && el.parentNode !== target) target.appendChild(el);
  }, [effectiveMode, host, topicId, chatColumn]);

  // Single entry point for the two-way choice. Expanding records the style as
  // the preference; docking deliberately does NOT overwrite it, so the last
  // *expand* style is what survives a reload.
  //
  // Focus: moving the panel node between hosts blurs whatever was focused
  // inside it, so without this every switch would drop keyboard focus on
  // <body>. It lands on the segment that matters — the active one while
  // expanded, the preferred one once docked.
  const applyChatMode = useCallback((next: ChatMode) => {
    setChatMode(next);
    if (next !== 'docked') {
      setPreferredExpand(next);
      try {
        window.localStorage.setItem(CHAT_MODE_KEY, next);
      } catch {
        // storage unavailable — the preference simply does not persist
      }
    }
    const focusMode = next === 'docked' ? preferredExpand : next;
    requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector<HTMLButtonElement>(`.chat-mode-btn[data-chat-mode="${focusMode}"]`)
        ?.focus();
    });
  }, [preferredExpand]);

  const collapseChat = useCallback(() => applyChatMode('docked'), [applyChatMode]);

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
    <aside
      style={
        chatColumn
          ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 0 }
          : { display: 'flex', flexDirection: 'column', gap: 0 }
      }
    >
      {/* Topic-specific info (when on a topic page). In chat-column mode the
          chat header already carries the topic name, so this card collapses to
          the description + member count and gives its height to the chat. */}
      {topicId && topicTitle && (
        <div style={
          chatColumn
            ? { ...sidebarCardStyle, padding: '12px 14px', marginBottom: 10, flexShrink: 0 }
            : sidebarCardStyle
        }>
          <div style={sectionHeadingStyle}>About this topic</div>
          {!chatColumn && (
            <div style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--foreground)',
              marginBottom: 6,
              letterSpacing: '-0.01em',
            }}>
              {topicTitle}
            </div>
          )}
          {topicDescription && (
            <p style={{
              fontSize: 13,
              color: 'var(--muted)',
              margin: chatColumn ? '0 0 8px' : '0 0 10px',
              lineHeight: 1.5,
              ...(chatColumn ? {
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const,
              } : null),
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

      {/* Live Chat dock — the panel node lives here while docked. In the two
          expanded modes the panel is moved out and this slot is left empty; no
          stand-in is rendered because both shells cover the column completely
          (the right-edge panel is always at least as wide as --chat-col-w, and
          the modal has a backdrop), and a covered button would only add an
          unreachable tab stop. */}
      {topicId && (
        <div
          ref={dockSlotRef}
          style={
            chatColumn
              ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
              : { marginBottom: 12 }
          }
        />
      )}

      {/* The panel itself renders into a stable detached host, so moving it
          between the dock and the maximized dialog never remounts it.
          Gated on `isDesktop`: below 1024px this sidebar is `display: none` but
          would still MOUNT the panel, giving the page two live ChatPanels (this
          one plus CommunityLayout's mobile sheet). Both would race to MLS-open
          the same message and the loser would render '[unable to decrypt]'. */}
      {topicId && host && isDesktop && createPortal(
        <ChatPanel
          topicId={topicId}
          isGuest={isGuest ?? true}
          isMember={isMember ?? false}
          title={chatColumn ? topicTitle : undefined}
          fullHeight={chatColumn || effectiveMode !== 'docked'}
          framed={chatColumn && effectiveMode === 'docked'}
          mode={effectiveMode}
          // Inline header controls — never overlap PresenceDots.
          onModeChange={applyChatMode}
        />,
        host,
      )}

      {effectiveMode === 'sidebar' && (
        <SidebarChatShell slotRef={sidebarSlotRef} onClose={collapseChat} />
      )}
      {effectiveMode === 'modal' && (
        <MaximizedChatShell slotRef={maximizedSlotRef} onClose={collapseChat} />
      )}

      {/* Recent Posts — hidden in chat-column mode, where the column height
          belongs to the chat. The topic feed is already in the center column. */}
      {!chatColumn && (
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
      )}

      <style>{`
        .chat-mode-btn:hover {
          color: var(--foreground);
          background: rgba(120, 140, 255, 0.12);
        }
        .chat-mode-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
      `}</style>
    </aside>
  );
}
