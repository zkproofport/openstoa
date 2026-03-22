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
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [askLoading, setAskLoading] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data?.userId) setUser(data);
      })
      .catch(() => {});
  }, []);

  function openAsk() {
    setAskOpen(true);
    setQuestion('');
    setAnswer(null);
    setAskError(null);
  }

  function closeAsk() {
    setAskOpen(false);
  }

  async function submitAsk() {
    if (!question.trim() || askLoading) return;
    setAskLoading(true);
    setAnswer(null);
    setAskError(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAskError(data.error || 'Something went wrong');
      } else {
        setAnswer(data.answer);
      }
    } catch {
      setAskError('Network error. Please try again.');
    } finally {
      setAskLoading(false);
    }
  }

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
          <button
            onClick={openAsk}
            className="header-nav-link"
            style={{
              color: '#788cff', fontSize: 12, background: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s', cursor: 'pointer',
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
          </button>

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

          {user ? (
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

      {/* Ask modal */}
      {askOpen && (
        <div
          onClick={closeAsk}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 16px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgb(10,14,26)',
              border: '1px solid rgba(120,140,255,0.2)',
              borderRadius: 12,
              padding: '28px 28px 24px',
              width: '100%', maxWidth: 560,
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}
          >
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                color: '#788cff', fontWeight: 600,
              }}>
                Ask OpenStoa AI
              </span>
              <button
                onClick={closeAsk}
                style={{
                  background: 'none', border: 'none', color: '#666',
                  cursor: 'pointer', padding: 4, borderRadius: 4,
                  lineHeight: 1, transition: 'color 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ccc'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Input */}
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAsk();
              }}
              placeholder="What would you like to know about OpenStoa?"
              rows={3}
              maxLength={1000}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(120,140,255,0.15)',
                borderRadius: 8, padding: '12px 14px',
                color: '#e8e8f0', fontSize: 14,
                fontFamily: 'var(--font-sans)',
                resize: 'none', outline: 'none',
                transition: 'border-color 0.15s',
                lineHeight: 1.55,
              }}
              onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.4)'; }}
              onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)'; }}
              autoFocus
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, marginBottom: 16 }}>
              <span style={{ fontSize: 11, color: '#444', fontFamily: 'var(--font-mono)' }}>
                {question.length}/1000
              </span>
              <span style={{ fontSize: 11, color: '#555', fontFamily: 'var(--font-mono)' }}>
                ⌘↵ to submit
              </span>
            </div>

            {/* Submit button */}
            <button
              onClick={submitAsk}
              disabled={!question.trim() || askLoading}
              style={{
                width: '100%', padding: '10px 0',
                background: question.trim() && !askLoading ? 'rgba(120,140,255,0.15)' : 'rgba(120,140,255,0.05)',
                border: '1px solid rgba(120,140,255,0.25)',
                borderRadius: 8, color: question.trim() && !askLoading ? '#788cff' : '#444',
                fontFamily: 'var(--font-mono)', fontSize: 12,
                letterSpacing: '0.05em', textTransform: 'uppercase',
                cursor: question.trim() && !askLoading ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {askLoading ? 'Thinking…' : 'Ask'}
            </button>

            {/* Answer */}
            {answer && (
              <div style={{
                marginTop: 20,
                padding: '16px 18px',
                background: 'rgba(120,140,255,0.05)',
                border: '1px solid rgba(120,140,255,0.12)',
                borderRadius: 8,
                color: '#c8c8d8', fontSize: 14,
                fontFamily: 'var(--font-sans)', lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
                maxHeight: 280, overflowY: 'auto',
              }}>
                {answer}
              </div>
            )}

            {/* Error */}
            {askError && (
              <div style={{
                marginTop: 16,
                padding: '12px 16px',
                background: 'rgba(255,80,80,0.06)',
                border: '1px solid rgba(255,80,80,0.2)',
                borderRadius: 8,
                color: '#ff6b6b', fontSize: 13,
                fontFamily: 'var(--font-sans)',
              }}>
                {askError}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 767px) {
          .header-hamburger {
            display: flex !important;
            align-items: center;
            justify-content: center;
          }
          .header-nav {
            gap: 4px !important;
          }
          .header-nav-link {
            padding: 5px 8px !important;
            font-size: 11px !important;
          }
        }
        @media (max-width: 380px) {
          .header-nav-link {
            padding: 4px 6px !important;
            font-size: 10px !important;
            letter-spacing: 0.02em !important;
          }
        }
      `}</style>
    </header>
  );
}
