'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Header from '@/components/Header';
import LeftSidebar from '@/components/LeftSidebar';
import RightSidebar from '@/components/RightSidebar';
import ChatRail from '@/components/ChatRail';
import { useMediaQuery, DESKTOP_CHAT_QUERY } from '@/hooks/useMediaQuery';
import { readRailOpenPreference, writeRailOpenPreference, type RailRoom } from '@/lib/chatRail';
import { ChatRailContext } from '@/lib/chatRailContext';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CommunityLayoutProps {
  children: React.ReactNode;
  isGuest: boolean;
  sessionChecked: boolean;
  activeCategory?: string | null;
  onCategorySelect?: (slug: string | null) => void;
  onTagSelect?: (slug: string | null) => void;
  activeTag?: string | null;
  viewMode?: 'all' | 'my';
  onViewChange?: (view: 'all' | 'my') => void;
  /** Pass topic-specific data for the right sidebar when on a topic page */
  topicId?: string;
  topicTitle?: string;
  topicDescription?: string;
  topicMemberCount?: number;
  isMember?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEADER_HEIGHT = 49; // sticky header height (padding 12*2 + content ~25)
const LEFT_WIDTH = 240;
const GAP = 20;
const MAX_WIDTH = 1400;

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * App shell: header, left nav, centred content + info sidebar, and the chat
 * rail (`ChatRail.tsx`) as a genuine right-edge column — a flex sibling of
 * the centred content block, so opening it visibly reflows the feed narrower
 * instead of floating over it (the previous `RightSidebar`-hosted
 * docked/sidebar/modal system is gone).
 *
 * The rail is independent of `topicId`/`isMember`/`isGuest` for members —
 * unlike the old docked chat column, it is available on every page and lists
 * both topic chats and DMs (see `ChatRail.tsx`). It is still gated on
 * `!isGuest`: a guest has no chat to see, and `Header`'s toggle button is
 * separately gated on ITS OWN resolved session, so a guest never even sees a
 * button for a rail this component would refuse to render.
 */
export default function CommunityLayout({
  children,
  isGuest,
  sessionChecked,
  activeCategory,
  onCategorySelect,
  onTagSelect,
  activeTag,
  viewMode,
  onViewChange,
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
}: CommunityLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Default closed on every mount (SSR-safe — localStorage does not exist on
  // the server); the persisted preference is applied client-side right after,
  // same pattern RightSidebar used for its old "preferred expand style".
  const [railOpen, setRailOpen] = useState(false);
  // A discovery entry point elsewhere on the page (left-nav "Chat", a topic
  // page's "Open topic chat") can ask the rail to jump straight to a room —
  // see `openRail` below and the `openRequest` doc in `ChatRail.tsx`.
  const [railRequest, setRailRequest] = useState<{ room: RailRoom | null; nonce: number } | null>(null);
  const railRequestNonce = useRef(0);
  const pathname = usePathname();
  const router = useRouter();

  // Rail geometry decides presentation: a real column on desktop, a
  // full-screen sheet below the breakpoint (a rail wide enough to be usable
  // cannot also fit beside content on a phone).
  const isDesktop = useMediaQuery(DESKTOP_CHAT_QUERY);

  useEffect(() => {
    setRailOpen(readRailOpenPreference());
  }, []);

  const toggleRail = useCallback(() => {
    setRailOpen((v) => {
      const next = !v;
      writeRailOpenPreference(next);
      return next;
    });
  }, []);
  const closeRail = useCallback(() => {
    setRailOpen(false);
    writeRailOpenPreference(false);
  }, []);

  // Open (or ensure-open) the rail and jump it to `room` — `null` means the
  // room list. Idempotent open: if the rail is already open on the desired
  // room, `railOpen` staying `true` triggers no remount, but `railRequestNonce`
  // still advances so `ChatRail`'s effect re-applies the target (see its doc).
  const openRail = useCallback((room: RailRoom | null = null) => {
    setRailOpen(true);
    writeRailOpenPreference(true);
    railRequestNonce.current += 1;
    setRailRequest({ room, nonce: railRequestNonce.current });
  }, []);

  // Close mobile menu on route changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth >= 768) {
        setMobileMenuOpen(false);
      }
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Lock body scroll when the mobile menu or the full-screen mobile rail is open.
  const mobileRailOpen = railOpen && !isDesktop;
  useEffect(() => {
    if (mobileMenuOpen || mobileRailOpen) {
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
    }
  }, [mobileMenuOpen, mobileRailOpen]);

  // Nudge the topic page's floating compose button clear of the desktop rail
  // column via a body class (the button is `position: fixed`, anchored to the
  // viewport, so it needs to know the rail is eating into that space).
  useEffect(() => {
    const open = railOpen && isDesktop;
    document.body.classList.toggle('chat-rail-open', open);
    return () => {
      document.body.classList.remove('chat-rail-open');
    };
  }, [railOpen, isDesktop]);

  const showRail = !isGuest && railOpen;

  return (
    <ChatRailContext.Provider value={{ openRail }}>
      <Header
        onMenuToggle={() => setMobileMenuOpen((v) => !v)}
        menuOpen={mobileMenuOpen}
        onChatToggle={!isGuest ? toggleRail : undefined}
        chatOpen={railOpen}
      />

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 70,
          }}
        />
      )}

      {/* Mobile sidebar drawer */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 280,
          background: 'var(--background)',
          borderRight: '1px solid var(--border)',
          zIndex: 80,
          transform: mobileMenuOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s ease',
          overflowY: 'auto',
          padding: '16px',
          paddingTop: 60,
        }}
        className="mobile-sidebar-drawer"
      >
        <button
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: 4,
          }}
          aria-label="Close sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <LeftSidebar
          isGuest={isGuest}
          sessionChecked={sessionChecked}
          activeCategory={activeCategory}
          viewMode={viewMode}
          onViewChange={(view) => {
            if (onViewChange) onViewChange(view);
            setMobileMenuOpen(false);
          }}
          onCategorySelect={(slug) => {
            if (onCategorySelect) {
              onCategorySelect(slug);
            } else {
              router.push(slug ? `/topics?category=${encodeURIComponent(slug)}` : '/topics');
            }
            setMobileMenuOpen(false);
          }}
          onTagSelect={(slug) => {
            if (onTagSelect) {
              onTagSelect(slug);
            } else {
              router.push(slug ? `/topics?tag=${encodeURIComponent(slug)}` : '/topics');
            }
            setMobileMenuOpen(false);
          }}
          activeTag={activeTag}
          onOpenChat={!isGuest ? () => {
            openRail(null);
            setMobileMenuOpen(false);
          } : undefined}
        />
      </div>

      {/* ── Page row: centred content + the chat rail as a real flex sibling ──
          so opening the rail shrinks the centred block's available width and
          its own `max-width: 1400px, margin: auto` recomputes narrower —
          the rail visibly pushes the feed, it never floats above it. */}
      <div style={{ display: 'flex', width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              maxWidth: MAX_WIDTH,
              margin: '0 auto',
              padding: `0 ${GAP}px`,
              display: 'flex',
              gap: GAP,
              alignItems: 'flex-start',
              minHeight: `calc(100vh - ${HEADER_HEIGHT}px)`,
            }}
          >
            {/* Left sidebar -- hidden below 768px (handled by CSS) */}
            <div
              className="layout-left-sidebar"
              style={{
                width: LEFT_WIDTH,
                flexShrink: 0,
                position: 'sticky',
                top: HEADER_HEIGHT + 16,
                maxHeight: `calc(100vh - ${HEADER_HEIGHT + 32}px)`,
                overflowY: 'auto',
                paddingTop: 20,
                paddingBottom: 20,
              }}
            >
              <LeftSidebar
                isGuest={isGuest}
                sessionChecked={sessionChecked}
                activeCategory={activeCategory}
                viewMode={viewMode}
                onViewChange={onViewChange}
                onCategorySelect={onCategorySelect ?? ((slug) => {
                  router.push(slug ? `/topics?category=${encodeURIComponent(slug)}` : '/topics');
                })}
                onTagSelect={onTagSelect ?? ((slug) => {
                  router.push(slug ? `/topics?tag=${encodeURIComponent(slug)}` : '/topics');
                })}
                activeTag={activeTag}
                onOpenChat={!isGuest ? () => openRail(null) : undefined}
              />
            </div>

            {/* Center content */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                paddingTop: 20,
                paddingBottom: 80,
              }}
            >
              {children}
            </div>

            {/* Right sidebar -- hidden below 1024px (handled by CSS). Purely
                informational now (topic summary + recent posts) — chat lives
                in the rail, not here. */}
            <div
              className="layout-right-sidebar"
              style={{
                width: 300,
                flexShrink: 0,
                position: 'sticky',
                top: HEADER_HEIGHT + 16,
                paddingTop: 20,
                paddingBottom: 20,
                maxHeight: `calc(100vh - ${HEADER_HEIGHT + 32}px)`,
                overflowY: 'auto',
              }}
            >
              <RightSidebar
                topicId={topicId}
                topicTitle={topicTitle}
                topicDescription={topicDescription}
                topicMemberCount={topicMemberCount}
                onOpenChat={!isGuest && topicId && topicTitle
                  ? () => openRail({ kind: 'topic', topicId, title: topicTitle })
                  : undefined}
              />
            </div>
          </div>
        </div>

        {/* Desktop chat rail column. `showRail` already excludes guests;
            `isDesktop` picks the column presentation over the full-screen
            sheet below. Exactly one `ChatRail` (and therefore at most one
            live `ChatPanel`) is ever mounted for the whole app at a time —
            this branch and the mobile sheet branch below are mutually
            exclusive on `isDesktop`. */}
        {showRail && isDesktop && (
          <div
            className="chat-rail-col"
            style={{
              width: 'var(--rail-w)',
              flexShrink: 0,
              position: 'sticky',
              top: HEADER_HEIGHT + 16,
              height: `calc(100vh - ${HEADER_HEIGHT + 32}px)`,
              paddingTop: 20,
              paddingBottom: 20,
              paddingRight: GAP,
              boxSizing: 'border-box',
            }}
          >
            <ChatRail onClose={closeRail} openRequest={railRequest} />
          </div>
        )}
      </div>

      {/* ── Full-screen chat rail (below the desktop breakpoint) ── */}
      {showRail && !isDesktop && (
        <div
          className="chat-rail-full-screen"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--background)',
            zIndex: 95,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <ChatRail onClose={closeRail} openRequest={railRequest} />
        </div>
      )}

      {/* ── Responsive CSS ── */}
      <style>{`
        /* Chat rail column width — a real column, not an overlay, so it can
           afford to be narrower than the old overlay panel (it never has to
           fully cover anything). Grows slightly on roomier displays so
           message text is not cramped. */
        :root { --rail-w: 340px; }
        @media (min-width: 1300px) { :root { --rail-w: 380px; } }
        @media (min-width: 1600px) { :root { --rail-w: 420px; } }

        /* Floating compose button (topic page): viewport-anchored by default,
           nudged left of the rail once it is open on desktop. */
        .topic-compose-fab {
          right: 32px;
        }
        @media (min-width: 1024px) {
          body.chat-rail-open .topic-compose-fab {
            right: calc(var(--rail-w) + 48px);
          }
        }
        /* Hide left sidebar on small screens */
        @media (max-width: 767px) {
          .layout-left-sidebar {
            display: none !important;
          }
        }
        @media (min-width: 768px) {
          .mobile-sidebar-drawer {
            display: none !important;
          }
        }
        /* Hide right sidebar on medium screens */
        @media (max-width: 1023px) {
          .layout-right-sidebar {
            display: none !important;
          }
        }
        /* Sidebar scrollbar styling */
        .layout-left-sidebar::-webkit-scrollbar,
        .layout-right-sidebar::-webkit-scrollbar {
          width: 4px;
        }
        .layout-left-sidebar::-webkit-scrollbar-thumb,
        .layout-right-sidebar::-webkit-scrollbar-thumb {
          background: var(--border);
          border-radius: 2px;
        }
      `}</style>
    </ChatRailContext.Provider>
  );
}
