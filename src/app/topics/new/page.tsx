'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';

export default function NewTopicPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requiresCountry, setRequiresCountry] = useState(false);
  const [countryCodes, setCountryCodes] = useState('');
  const [countryMode, setCountryMode] = useState<'include' | 'exclude'>('include');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError(null);

    let allowedCountries: string[] | undefined;
    if (requiresCountry && countryCodes.trim()) {
      allowedCountries = countryCodes
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length === 2);
    }

    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          requiresCountryProof: requiresCountry,
          allowedCountries,
          countryMode: requiresCountry ? countryMode : undefined,
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to create topic');
      }

      const data = await res.json();
      router.push(`/topics/${data.topic.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  const canSubmit = title.trim().length > 0 && !loading;

  return (
    <>
      <Header />
      <div style={{ paddingTop: 40, paddingBottom: 80, maxWidth: 560 }}>
        <div style={{ marginBottom: 32, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link
            href="/topics"
            style={{
              color: 'var(--muted)',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            ← Topics
          </Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>New</span>
        </div>

        <h1
          style={{
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: '0 0 28px',
          }}
        >
          Create Topic
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Title */}
          <div>
            <label
              htmlFor="title"
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Title <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. DeFi strategies for KYC-verified users"
              maxLength={100}
              autoFocus
              style={{
                width: '100%',
                background: '#111',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 14px',
                color: 'var(--foreground)',
                fontSize: 15,
                outline: 'none',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="description"
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Description{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>(optional)</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this topic about?"
              rows={3}
              style={{
                width: '100%',
                background: '#111',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 14px',
                color: 'var(--foreground)',
                fontSize: 14,
                outline: 'none',
                resize: 'vertical',
                lineHeight: 1.6,
                fontFamily: 'inherit',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Country gating */}
          <div
            style={{
              padding: '16px 20px',
              background: '#111',
              border: `1px solid ${requiresCountry ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
              borderRadius: 12,
              transition: 'border-color 0.15s',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={requiresCountry}
                onChange={(e) => setRequiresCountry(e.target.checked)}
                style={{
                  width: 16,
                  height: 16,
                  accentColor: 'var(--accent)',
                  cursor: 'pointer',
                }}
              />
              <div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Require Country Proof</span>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>
                  Members must provide a ZK proof of their country via Coinbase attestation
                </p>
              </div>
            </label>

            {requiresCountry && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Include / Exclude toggle */}
                <div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                    Country filter mode
                  </p>
                  <div className="flex gap-2">
                    {(['include', 'exclude'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCountryMode(mode)}
                        style={{
                          background: countryMode === mode ? 'var(--accent)' : 'var(--border)',
                          color: countryMode === mode ? '#fff' : 'var(--muted)',
                          border: 'none',
                          borderRadius: 6,
                          padding: '6px 16px',
                          fontSize: 13,
                          cursor: 'pointer',
                          fontWeight: countryMode === mode ? 600 : 400,
                          transition: 'all 0.12s',
                        }}
                      >
                        {mode === 'include' ? 'Allow only' : 'Block'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="countries"
                    style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    ISO country codes (comma-separated)
                  </label>
                  <input
                    id="countries"
                    type="text"
                    value={countryCodes}
                    onChange={(e) => setCountryCodes(e.target.value)}
                    placeholder="US, KR, JP, DE"
                    style={{
                      width: '100%',
                      background: '#0a0a0a',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '10px 12px',
                      color: 'var(--foreground)',
                      fontSize: 13,
                      outline: 'none',
                      fontFamily: 'monospace',
                      letterSpacing: '0.04em',
                    }}
                  />
                  {countryCodes && (
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {countryCodes
                        .split(',')
                        .map((s) => s.trim().toUpperCase())
                        .filter((s) => s.length > 0)
                        .map((code, i) => (
                          <span
                            key={i}
                            style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              background:
                                code.length === 2
                                  ? 'rgba(34,197,94,0.1)'
                                  : 'rgba(239,68,68,0.1)',
                              color: code.length === 2 ? '#22c55e' : '#ef4444',
                              border: `1px solid ${code.length === 2 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}
                          >
                            {code}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            )}
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

          <div className="flex gap-3">
            <Link
              href="/topics"
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '12px',
                background: 'var(--border)',
                color: 'var(--muted)',
                textDecoration: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                flex: 2,
                background: canSubmit ? 'var(--accent)' : 'var(--border)',
                color: canSubmit ? '#fff' : 'var(--muted)',
                border: 'none',
                borderRadius: 8,
                padding: '12px',
                fontSize: 14,
                fontWeight: 600,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {loading ? 'Creating...' : 'Create Topic'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
