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

export default function Header({ onMenuToggle, menuOpen }: HeaderProps = {}) {
  const [user, setUser] = useState<UserSession | null>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data?.userId) setUser(data);
      })
      .catch(() => {});
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
          {/* Mini arch logo */}
          <svg width={24} height={24} viewBox="0 0 64 64" fill="none">
            <path d="M14 54 L14 26 C14 14 22 6 32 6 C42 6 50 14 50 26 L50 54"
              stroke="#788cff" strokeWidth="2.5" fill="none" />
            <circle cx="32" cy="6" r="3" fill="#788cff" />
            <line x1="10" y1="54" x2="54" y2="54" stroke="#788cff" strokeWidth="1.5" opacity="0.4" />
          </svg>
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

        <nav style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <Link
            href="/topics"
            style={{
              color: '#666', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
          >
            Topics
          </Link>

          <Link
            href="/recorded"
            style={{
              color: '#666', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
          >
            Recorded
          </Link>

          <Link
            href="/docs"
            style={{
              color: '#666', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
          >
            Docs
          </Link>

          {user ? (
            <Link
              href="/my"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 13, color: '#ccc',
                background: 'rgba(120,140,255,0.1)', border: '1px solid rgba(120,140,255,0.15)',
                padding: '4px 12px', borderRadius: 6,
                textDecoration: 'none', transition: 'all 0.15s',
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
                fontFamily: 'var(--font-mono)', fontSize: 13, color: '#666',
                textDecoration: 'none', transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#aaa'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
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
        }
      `}</style>
    </header>
  );
}
