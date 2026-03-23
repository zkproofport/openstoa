'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Header from '@/components/Header';
import LeftSidebar from '@/components/LeftSidebar';
import RightSidebar from '@/components/RightSidebar';
import ChatPanel from '@/components/ChatPanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CommunityLayoutProps {
  children: React.ReactNode;
  isGuest: boolean;
  sessionChecked: boolean;
  activeCategory?: string | null;
  onCategorySelect?: (slug: string | null) => void;
  onTagSelect?: (slug: string | null) => void;
  activeTag?: string | null;
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
const RIGHT_WIDTH = 300;
const GAP = 20;
const MAX_WIDTH = 1400;

// ─── Component ───────────────────────────────────────────────────────────────

export default function CommunityLayout({
  children,
  isGuest,
  sessionChecked,
  activeCategory,
  onCategorySelect,
  onTagSelect,
  activeTag,
  topicId,
  topicTitle,
  topicDescription,
  topicMemberCount,
  isMember,
}: CommunityLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

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

  // Lock body scroll when mobile menu or chat is open
  useEffect(() => {
    if (mobileMenuOpen || mobileChatOpen) {
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
  }, [mobileMenuOpen, mobileChatOpen]);

  return (
    <>
      <Header
        onMenuToggle={() => setMobileMenuOpen((v) => !v)}
        menuOpen={mobileMenuOpen}
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
        />
      </div>

      {/* ── Main 3-column layout ── */}
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
            onCategorySelect={onCategorySelect ?? ((slug) => {
              router.push(slug ? `/topics?category=${encodeURIComponent(slug)}` : '/topics');
            })}
            onTagSelect={onTagSelect ?? ((slug) => {
              router.push(slug ? `/topics?tag=${encodeURIComponent(slug)}` : '/topics');
            })}
            activeTag={activeTag}
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

        {/* Right sidebar -- hidden below 1024px (handled by CSS) */}
        <div
          className="layout-right-sidebar"
          style={{
            width: RIGHT_WIDTH,
            flexShrink: 0,
            position: 'sticky',
            top: HEADER_HEIGHT + 16,
            maxHeight: `calc(100vh - ${HEADER_HEIGHT + 32}px)`,
            overflowY: 'auto',
            paddingTop: 20,
            paddingBottom: 20,
          }}
        >
          <RightSidebar
            topicId={topicId}
            topicTitle={topicTitle}
            topicDescription={topicDescription}
            topicMemberCount={topicMemberCount}
            isGuest={isGuest}
            isMember={isMember}
          />
        </div>
      </div>

      {/* ── Mobile chat bottom sheet ── */}
      {topicId && isMember && !isGuest && (
        <>
          {/* Floating chat button (visible only on mobile <1024px) */}
          <button
            className="mobile-chat-fab"
            onClick={() => setMobileChatOpen(true)}
            style={{
              position: 'fixed',
              bottom: 32,
              left: 24,
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 20px rgba(59,130,246,0.3)',
              zIndex: 50,
              fontSize: 20,
            }}
            title="Open Chat"
          >
            💬
          </button>

          {/* Full-screen mobile chat */}
          <div
            className="mobile-chat-sheet"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--background)',
              zIndex: 95,
              transform: mobileChatOpen ? 'translateY(0)' : 'translateY(100%)',
              transition: 'transform 0.3s ease',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Close button bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: '8px 16px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}>
              <button
                onClick={() => setMobileChatOpen(false)}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: 500,
                }}
                aria-label="Close chat"
              >
                Close
              </button>
            </div>
            {/* Chat content — fills remaining space */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <ChatPanel topicId={topicId} isGuest={isGuest} isMember={isMember ?? false} fullHeight />
            </div>
          </div>
        </>
      )}

      {/* ── Responsive CSS ── */}
      <style>{`
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
        /* Show mobile chat FAB only below 1024px */
        .mobile-chat-fab {
          display: none !important;
        }
        @media (max-width: 1023px) {
          .mobile-chat-fab {
            display: flex !important;
          }
        }
        /* Hide mobile chat sheet on desktop */
        @media (min-width: 1024px) {
          .mobile-chat-overlay,
          .mobile-chat-sheet {
            display: none !important;
          }
        }
        /* Hide expand button on mobile (right sidebar is hidden there anyway) */
        @media (max-width: 1023px) {
          .chat-expand-btn {
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
    </>
  );
}
