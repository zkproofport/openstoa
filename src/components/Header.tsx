'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface UserSession {
  nickname?: string;
  userId?: string;
}

interface HeaderProps {
  onMenuToggle?: () => void;
  menuOpen?: boolean;
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

export default function Header({ onMenuToggle, menuOpen }: HeaderProps = {}) {
  const [user, setUser] = useState<UserSession | null>(() => getCachedSession());
  const [sessionChecked, setSessionChecked] = useState(() => !!getCachedSession());

  useEffect(() => {
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
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="header-hamburger"
              style={{
                display: 'none',
                background: 'none',
                border: 'none',
                color: 'var(--foreground)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                transition: 'color 0.12s',
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
            aria-label="OpenStoa home"
          >
          {/* Logo mark */}
          <img src="/images/openstoa-logo-mark-transparent.png" alt="OpenStoa" width={24} height={24} style={{ objectFit: 'contain' }} />
          <span
            style={{
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 16,
              letterSpacing: '-0.03em', color: '#fff',
            }}
          >
            Open<span style={{ color: '#788cff' }}>Stoa</span>
          </span>
        </Link>
        </div>

        <nav style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="header-nav">
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

          <Link
            href="/topics/explore"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px 14px', borderRadius: 6,
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
            Explore
          </Link>

          <Link
            href="/recorded"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px 14px', borderRadius: 6,
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
            Recorded
          </Link>

          <Link
            href="/docs"
            className="header-nav-link"
            style={{
              color: '#999', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px 14px', borderRadius: 6,
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
            Docs
          </Link>

          {!sessionChecked ? (
            <span style={{ width: 70, height: 30 }} />
          ) : user ? (
            <Link
              href="/my"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 12, color: '#ccc',
                background: 'rgba(120,140,255,0.1)', border: '1px solid rgba(120,140,255,0.15)',
                padding: '6px 14px', borderRadius: 6,
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
                  : 'anon')}
            </Link>
          ) : (
            <Link
              href="/"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)',
                textDecoration: 'none', transition: 'all 0.15s',
                padding: '6px 14px', borderRadius: 6,
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
              Sign in
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
            font-size: 10px !important;
            border: none !important;
          }
        }
        @media (max-width: 380px) {
          .header-nav-link {
            padding: 3px 4px !important;
            font-size: 9px !important;
            letter-spacing: 0.01em !important;
          }
        }
      `}</style>
    </header>
  );
}
