import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * `GET /api/auth/poll/[requestId]` — the catch-all's residual leak fix.
 *
 * This route used to classify "not found or expired" by testing whether the
 * caught error's message CONTAINED either substring, then echoed the caught
 * message verbatim on a match — leaking whatever else that text carried on
 * a false-positive match, and echoing arbitrary upstream text even on a true
 * one. It now `instanceof`-checks a typed `RelayRequestNotFoundError` (see
 * relay.test.ts for the SDK-message-to-typed-error conversion) and returns a
 * FIXED literal the route owns, never the caught text.
 */
const mocks = vi.hoisted(() => ({
  pollProofResult: vi.fn(),
}));

vi.mock('@/lib/relay', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay')>('@/lib/relay');
  return {
    ...actual,
    pollProofResult: mocks.pollProofResult,
  };
});

function req(requestId: string) {
  return new NextRequest(`http://localhost:3200/api/auth/poll/${requestId}`);
}

describe('GET /api/auth/poll/[requestId] — error-path result integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a typed RelayRequestNotFoundError becomes a clean 404 with the fixed message', async () => {
    const { RelayRequestNotFoundError } = await import('@/lib/relay');
    mocks.pollProofResult.mockRejectedValue(new RelayRequestNotFoundError());
    const { GET } = await import('@/app/api/auth/poll/[requestId]/route');

    const res = await GET(req('gone'), { params: Promise.resolve({ requestId: 'gone' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Request not found or expired' });
  });

  it('an arbitrary relay error (never seen the typed error) falls through to the generic 500 — no leaked text', async () => {
    mocks.pollProofResult.mockRejectedValue(
      new Error('relay says: connection to postgres://relay-db-internal:5432 refused'),
    );
    const { GET } = await import('@/app/api/auth/poll/[requestId]/route');

    const res = await GET(req('x'), { params: Promise.resolve({ requestId: 'x' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'errorId']);
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(JSON.stringify(body)).not.toContain('relay-db-internal');
  });

  it('an error whose text merely CONTAINS "not found" (but is not the typed error) is NOT treated as 404 — no leaked text', async () => {
    mocks.pollProofResult.mockRejectedValue(
      new Error('upstream host relay-shadow-7.internal not found, DNS lookup failed'),
    );
    const { GET } = await import('@/app/api/auth/poll/[requestId]/route');

    const res = await GET(req('y'), { params: Promise.resolve({ requestId: 'y' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('relay-shadow-7.internal');
    expect(JSON.stringify(body)).not.toContain('DNS lookup failed');
  });

  it('a non-Error thrown value also falls through to the generic 500 cleanly', async () => {
    mocks.pollProofResult.mockRejectedValue('a raw string throw');
    const { GET } = await import('@/app/api/auth/poll/[requestId]/route');

    const res = await GET(req('z'), { params: Promise.resolve({ requestId: 'z' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
  });
});
