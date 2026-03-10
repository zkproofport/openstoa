'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface UserSession {
  nickname?: string;
  userId?: string;
}

export default function Header() {
  const router = useRouter();
  const [user, setUser] = useState<UserSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setUser(data);
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <header
      style={{ borderBottom: '1px solid var(--border)' }}
      className="sticky top-0 z-50 py-4"
      role="banner"
    >
      <div
        style={{ background: 'rgba(10,10,10,0.92)', backdropFilter: 'blur(12px)' }}
        className="absolute inset-0 -z-10"
      />
      <div className="flex items-center justify-between">
        <Link
          href="/topics"
          className="flex items-center gap-2 group"
          aria-label="ZK Community home"
        >
          <span
            style={{
              background: 'var(--accent)',
              width: 28,
              height: 28,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
            }}
          >
            ZK
          </span>
          <span
            style={{ fontWeight: 600, letterSpacing: '-0.02em' }}
            className="text-base"
          >
            Community
          </span>
        </Link>

        <nav className="flex items-center gap-6">
          <Link
            href="/topics"
            style={{ color: 'var(--muted)', fontSize: 14 }}
            className="hover:text-white transition-colors"
          >
            Topics
          </Link>

          {user ? (
            <div className="flex items-center gap-3">
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: 'var(--foreground)',
                  background: 'var(--border)',
                  padding: '3px 10px',
                  borderRadius: 4,
                }}
              >
                {user.nickname ??
                  (user.userId
                    ? `${user.userId.slice(0, 6)}...${user.userId.slice(-4)}`
                    : 'anon')}
              </span>
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
                className="hover:text-white transition-colors disabled:opacity-50"
              >
                {loggingOut ? 'Logging out...' : 'Logout'}
              </button>
            </div>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
