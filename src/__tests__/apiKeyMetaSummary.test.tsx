// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiKeyMetaSummary } from '@/components/AiAgentSettings';
import { TestProviders } from './harness/providers';

function renderKey(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(TestProviders, { initialLocale: 'en', children: node }),
  );
}

/**
 * Render-level (SSR) coverage for the edge-case rows the KEY LIST owns, using
 * the same react-dom/server harness as sns-content.test.tsx (no RTL in repo).
 * The interactive, effect-driven parent (AiAgentSettings) is covered by helper
 * unit tests (apiKeyForm.test.ts) + the api-keys/ai-permissions e2e suites;
 * this file isolates the presentational metadata row.
 */
const base = {
  id: '00000000-0000-0000-0000-000000000000',
  isAI: true,
  cmd: [] as string[],
  historyGrant: 'none',
  createdAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

describe('ApiKeyMetaSummary — hostile name renders safely (no XSS)', () => {
  it('escapes an HTML/script-shaped key name instead of emitting live markup', () => {
    const out = renderKey(
      <ApiKeyMetaSummary k={{ ...base, name: '<script>alert(1)</script>', prefix: 'osk_1234abcd' }} />,
    );
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders UTF-8 (한글, emoji) names verbatim as text', () => {
    const out = renderKey(
      <ApiKeyMetaSummary k={{ ...base, name: '키_에이전트 🤖', prefix: 'osk_1234abcd' }} />,
    );
    expect(out).toContain('키_에이전트 🤖');
  });
});

describe('ApiKeyMetaSummary — list surface is metadata only', () => {
  it('emits the short prefix but never a full osk_ secret', () => {
    const out = renderKey(
      <ApiKeyMetaSummary k={{ ...base, name: 'laptop', prefix: 'osk_1234abcd' }} />,
    );
    expect(out).toContain('osk_1234abcd');
    // A raw key is osk_ + 48 hex chars; the display prefix must never reach that length.
    expect(out).not.toMatch(/osk_[0-9a-f]{48}/);
  });

  it('shows a Revoked badge when revokedAt is set', () => {
    const out = renderKey(
      <ApiKeyMetaSummary k={{ ...base, name: 'old', prefix: 'osk_deadbeef', revokedAt: new Date().toISOString() }} />,
    );
    expect(out).toContain('Revoked');
  });
});
