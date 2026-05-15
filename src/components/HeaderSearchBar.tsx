'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Sticky header search input — mirrors the mobile SearchBar pattern so
// users on web have the same entry point. Submit on Enter or magnifier
// tap routes to /topics?q=… so the feed page can run a server-side
// search across every post the viewer can see. The mobile feed does the
// same when the user submits from the global SearchBar.
export default function HeaderSearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [value, setValue] = useState<string>(() => searchParams.get('q') ?? '');

  // Reflect URL changes so the input stays in sync with route state
  // (e.g. when navigating between pages).
  useEffect(() => {
    setValue(searchParams.get('q') ?? '');
  }, [searchParams]);

  const submit = (next: string) => {
    const trimmed = next.trim();
    const params = new URLSearchParams();
    if (trimmed) params.set('q', trimmed);
    const qs = params.toString();
    router.push(qs ? `/topics?${qs}` : '/topics');
  };

  const clear = () => {
    setValue('');
    submit('');
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      className="header-search"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'rgba(120,140,255,0.06)',
        border: '1px solid rgba(120,140,255,0.15)',
        borderRadius: 8,
        padding: '4px 10px',
        height: 30,
        minWidth: 0,
        maxWidth: 280,
        flex: 1,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: 'var(--muted)', flexShrink: 0 }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        inputMode="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search posts, tags…"
        aria-label="Search"
        style={{
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--foreground)',
          fontSize: 13,
          fontFamily: 'var(--font-mono)',
          width: '100%',
          minWidth: 0,
          padding: 0,
        }}
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: 0,
            fontSize: 14,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      )}
    </form>
  );
}
