'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import HeaderSearchBar from '@/components/HeaderSearchBar';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface UserSession {
  nickname?: string;
  userId?: string;
}

interface HeaderProps {
  onMenuToggle?: () => void;
  menuOpen?: boolean;
  /** Toggles the chat rail (`ChatRail.tsx`, owned by `CommunityLayout`).
   *  Omitted on pages that render `Header` standalone (recovery/docs/profile),
   *  which have no rail to toggle — the button only renders when both this
   *  AND a resolved signed-in session are present (see render below). */
  onChatToggle?: () => void;
  chatOpen?: boolean;
}

function getCachedSession(): UserSession | null {
  try {
    const cached = localStorage.getItem('os-session');
    return cached ? JSON.parse(cached) : null;
  } catch { return null; }
}

function setCachedSession(data: UserSession | null) {
  try {
    if (data) localStorage.setItem('os-session', JSON.stringify(data));
    else localStorage.removeItem('os-session');
  } catch {}
}

export default function Header({ onMenuToggle, menuOpen, onChatToggle, chatOpen }: HeaderProps = {}) {
  const { t } = useTranslation();
  // Initial render MUST match SSR (no localStorage on the server).
  // Reading `getCachedSession()` in the useState initializer caused React
  // #418: the server rendered the guest placeholder span while the client's
  // first paint rendered the cached <Link href="/my">{nickname}</Link>, so
  // the SSR vs CSR HTML structure diverged on every page load and React
  // tore down + retried hydration in a postMessage retry loop. The cache
  // is now applied AFTER mount so SSR and the first client render match.
  const [user, setUser] = useState<UserSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    // Hydrate from cache first (avoids flashing the "Sign in" pill for
    // already-signed-in users) and mark the session as checked so the
    // header switches from the placeholder span to the real chip.
    const cached = getCachedSession();
    if (cached?.userId) {
      setUser(cached);
      setSessionChecked(true);
    }

    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data?.userId) {
          setUser(data);
          setCachedSession(data);
        } else {
          setUser(null);
          setCachedSession(null);
        }
      })
      .catch(() => {})
      .finally(() => setSessionChecked(true));
  }, []);

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 50, padding: '12px 0',
        borderBottom: '1px solid rgba(120,140,255,0.08)',
      }}
      role="banner"
    >
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: -1,
          background: 'rgba(5,8,16,0.92)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      />
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          maxWidth: 1400, margin: '0 auto', padding: '0 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mobile hamburger -- visible below 768px only */}
          {onMenuToggle && (
            <button
              onClick={onMenuToggle}
              aria-label={menuOpen ? t('header.closeMenu') : t('header.openMenu')}
              className="header-hamburger"
              style={{
                display: 'none',
                background: 'none',
                border: 'none',
                color: 'var(--foreground)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 'var(--radius-control)',
                transition: 'color 0.12s',
                // NOT bumped to --touch-target-min: `HEADER_HEIGHT = 49` in
                // CommunityLayout.tsx hardcodes this row's rendered height for
                // sticky-sidebar offset math; growing this control to 44px
                // would make the real header taller than that constant
                // assumes. See migration report.
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {menuOpen ? (
                  <>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </>
                )}
              </svg>
            </button>
          )}

          <Link
            href="/topics"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              textDecoration: 'none', color: 'inherit',
            }}
            aria-label={t('header.homeAriaLabel')}
          >
          {/* Logo mark */}
          <img src="/images/openstoa-logo-mark-transparent.png" alt="OpenStoa" width={24} height={24} style={{ objectFit: 'contain' }} />
          <span
            style={{
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 'var(--text-body)',
              letterSpacing: '-0.03em', color: '#fff',
            }}
          >
            Open<span style={{ color: '#788cff' }}>Stoa</span>
          </span>
        </Link>
        </div>

        {/* Sticky search — same affordance as mobile SearchBar. Wrapped
            in Suspense because next/navigation's useSearchParams suspends. */}
        <div className="header-search-wrap" style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '0 16px', minWidth: 0 }}>
          <Suspense fallback={<div style={{ height: 30 }} />}>
            <HeaderSearchBar />
          </Suspense>
        </div>

        <nav style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="header-nav">
          {/* DISABLED 2026-05-25: AI Ask link hidden because LLM API providers deprecated.
              See docs/migration/third-party-services.md §4-6 and /api/ask routes (commented).
              Re-enable by uncommenting the <Link> below.
          <Link
            href="/ask"
            className="header-nav-link"
            style={{
              color: '#788cff', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px 14px', borderRadius: 6,
              border: '1px solid rgba(120,140,255,0.25)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.1)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.5)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'none';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.25)';
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Ask
          </Link>
          */}

          <Link
            href="/topics/explore"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 'var(--text-label)', textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
              border: '1px solid transparent',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#ccc';
              (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.08)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#999';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
            }}
          >
            {t('header.explore')}
          </Link>

          <Link
            href="/recorded"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 'var(--text-label)', textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
              border: '1px solid transparent',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#ccc';
              (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.08)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#999';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
            }}
          >
            {t('header.recorded')}
          </Link>

          <Link
            href="/docs"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 'var(--text-label)', textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
              border: '1px solid transparent',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#ccc';
              (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.08)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#999';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
            }}
          >
            {t('header.docs')}
          </Link>

          {user && (
            <Link
              href="/dm"
              className="header-nav-link"
              style={{
                color: '#999', fontSize: 'var(--text-label)', textDecoration: 'none',
                fontFamily: 'var(--font-mono)', fontWeight: 500,
                letterSpacing: '0.04em', textTransform: 'uppercase' as const,
                transition: 'all 0.15s',
                padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
                border: '1px solid transparent',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#ccc';
                (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.08)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#999';
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
              }}
            >
              {t('header.messages')}
            </Link>
          )}

          {user && (
            <Link
              href="/recovery"
              className="header-nav-link"
              style={{
                color: '#999', fontSize: 'var(--text-label)', textDecoration: 'none',
                fontFamily: 'var(--font-mono)', fontWeight: 500,
                letterSpacing: '0.04em', textTransform: 'uppercase' as const,
                transition: 'all 0.15s',
                padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
                border: '1px solid transparent',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#ccc';
                (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.08)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#999';
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
              }}
            >
              {t('header.recovery')}
            </Link>
          )}

          {/* Chat rail toggle — gated the same way as the other signed-in-only
              links above (Messages/Recovery). `onChatToggle` is only passed by
              `CommunityLayout`, so standalone Header usages (recovery/docs/
              profile pages) never render a button with nothing to toggle. */}
          {user && onChatToggle && (
            <button
              type="button"
              onClick={onChatToggle}
              aria-pressed={chatOpen}
              aria-label={chatOpen ? t('chat.close') : t('header.openChat')}
              title={chatOpen ? t('chat.close') : t('header.openChat')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: chatOpen ? 'rgba(120,140,255,0.14)' : 'transparent',
                color: chatOpen ? 'var(--accent)' : '#999',
                border: `1px solid ${chatOpen ? 'rgba(120,140,255,0.3)' : 'transparent'}`,
                borderRadius: 'var(--radius-control)',
                padding: '6px 8px',
                cursor: 'pointer',
                transition: 'all 0.15s',
                // NOT bumped to --touch-target-min — see the hamburger button
                // above: this row's height is load-bearing for
                // CommunityLayout's hardcoded HEADER_HEIGHT.
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </button>
          )}

          {!sessionChecked ? (
            <span style={{ width: 70, height: 30 }} />
          ) : user ? (
            <Link
              href="/my"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)', color: '#ccc',
                background: 'rgba(120,140,255,0.1)', border: '1px solid rgba(120,140,255,0.15)',
                padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
                textDecoration: 'none', transition: 'all 0.15s',
                letterSpacing: '0.02em',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.18)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.3)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.1)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
              }}
            >
              {user.nickname ??
                (user.userId
                  ? `${user.userId.slice(0, 6)}…${user.userId.slice(-4)}`
                  : t('header.anonFallback'))}
            </Link>
          ) : (
            <Link
              href="/"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)', color: 'var(--accent)',
                textDecoration: 'none', transition: 'all 0.15s',
                padding: '6px var(--space-4)', borderRadius: 'var(--radius-control)',
                border: '1px solid rgba(120,140,255,0.25)',
                letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.1)';
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.25)';
              }}
            >
              {t('header.signIn')}
            </Link>
          )}
        </nav>
      </div>

      <style>{`
        @media (max-width: 767px) {
          .header-hamburger {
            display: flex !important;
            align-items: center;
            justify-content: center;
          }
          .header-nav {
            gap: 2px !important;
          }
          .header-nav-link {
            padding: 4px 6px !important;
            /* Was 10px, below the 12px floor even for an uppercase Latin
               label (--text-label is the floor, not a ceiling). */
            font-size: var(--text-label) !important;
            border: none !important;
          }
          .header-search-wrap {
            display: none !important;
          }
        }
        @media (max-width: 380px) {
          .header-nav-link {
            padding: 3px 4px !important;
            /* Was 9px, below the 12px floor. */
            font-size: var(--text-label) !important;
            letter-spacing: 0.01em !important;
          }
        }
      `}</style>
    </header>
  );
}
