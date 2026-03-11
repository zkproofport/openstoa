'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/Header';

const NICKNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfilePageInner />
    </Suspense>
  );
}

function ProfilePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') ?? '/topics';
  const [nickname, setNickname] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          router.replace('/');
          return;
        }
        if (data.nickname && !data.nickname.startsWith('anon_')) {
          router.replace(returnTo);
          return;
        }
        setUserId(data.userId ?? null);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  function validate(value: string): string | null {
    if (value.length < 2) return 'Minimum 2 characters';
    if (value.length > 20) return 'Maximum 20 characters';
    if (!NICKNAME_RE.test(value)) return 'Only letters, numbers, and underscore allowed';
    return null;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setNickname(val);
    setValidationError(val ? validate(val) : null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate(nickname);
    if (v) {
      setValidationError(v);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/profile/nickname', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to set nickname');
      }

      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const isValid = nickname.length >= 2 && !validationError;

  return (
    <>
      <Header />
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 0',
        }}
      >
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ marginBottom: 32 }}>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                margin: 0,
              }}
            >
              Choose a nickname
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
              Your public identity in ZK Community. You can&apos;t change this later.
            </p>
          </div>

          {userId && (
            <div
              style={{
                padding: '10px 14px',
                background: '#111',
                border: '1px solid var(--border)',
                borderRadius: 8,
                marginBottom: 24,
              }}
            >
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0, fontFamily: 'monospace' }}>
                Your verified identity
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--foreground)',
                  margin: '4px 0 0',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}
              >
                {userId.slice(0, 8)}...{userId.slice(-6)}
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="nickname"
                style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
              >
                Nickname
              </label>
              <input
                id="nickname"
                type="text"
                value={nickname}
                onChange={handleChange}
                placeholder="e.g. zk_dev_42"
                maxLength={20}
                autoFocus
                style={{
                  width: '100%',
                  background: '#111',
                  border: `1px solid ${validationError ? '#ef4444' : isValid && nickname ? '#22c55e' : 'var(--border)'}`,
                  borderRadius: 8,
                  padding: '12px 14px',
                  color: 'var(--foreground)',
                  fontSize: 15,
                  outline: 'none',
                  fontFamily: 'monospace',
                  transition: 'border-color 0.15s',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 6,
                }}
              >
                {validationError ? (
                  <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>{validationError}</p>
                ) : isValid && nickname ? (
                  <p style={{ fontSize: 12, color: '#22c55e', margin: 0 }}>Looks good</p>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                    Letters, numbers, underscores only
                  </p>
                )}
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                  {nickname.length}/20
                </p>
              </div>
            </div>

            {error && (
              <p
                style={{
                  fontSize: 13,
                  color: '#ef4444',
                  margin: 0,
                  fontFamily: 'monospace',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 6,
                  padding: '8px 12px',
                }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!isValid || loading}
              style={{
                background: isValid ? 'var(--accent)' : 'var(--border)',
                color: isValid ? '#fff' : 'var(--muted)',
                border: 'none',
                borderRadius: 8,
                padding: '12px',
                fontSize: 15,
                fontWeight: 600,
                cursor: isValid ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {loading ? 'Setting up...' : 'Continue →'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
