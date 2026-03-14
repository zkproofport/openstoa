'use client';

import { useState, useEffect } from 'react';
import Header from '@/components/Header';
import LeftSidebar from '@/components/LeftSidebar';
import RightSidebar from '@/components/RightSidebar';

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
}: CommunityLayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on route changes (resize)
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth >= 768) {
        setMobileMenuOpen(false);
      }
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);

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
            onCategorySelect?.(slug);
            setMobileMenuOpen(false);
          }}
          onTagSelect={(slug) => {
            onTagSelect?.(slug);
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
            onCategorySelect={onCategorySelect}
            onTagSelect={onTagSelect}
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
          />
        </div>
      </div>

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
