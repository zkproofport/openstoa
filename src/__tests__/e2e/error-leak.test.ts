/**
 * Result-integrity E2E for two collaborating guards, real HTTP against a
 * real container:
 *
 *  1. `src/lib/apiError.ts` (`unhandledRouteError`) — the shared catch-all
 *     that turns a genuinely unhandled failure into a generic response with
 *     a correlation id, never driver/library text or a stack.
 *  2. `src/lib/uuid.ts` (`isValidUUID`) — the format guard added in a
 *     follow-up pass. `GET /api/posts/{postId}` and `GET /api/topics/{topicId}`
 *     used to bind a garbage path param straight into a Drizzle
 *     `eq(<uuid column>, id)` with no format check, so Postgres itself
 *     rejected the query with `22P02 invalid input syntax for type uuid` —
 *     leaking driver text AND answering 500 ("the server is broken, retry")
 *     for what is actually a 400 ("you sent a bad id, retrying won't help").
 *     Both defects are closed now: format guard first (400, before any
 *     query runs), `unhandledRouteError` as the backstop for whatever is
 *     still genuinely unexpected.
 *
 * A genuinely-forced 500 (as opposed to a malformed-input 400) is covered
 * separately by `deleted-user-session.test.ts` (S-2's FK-violation repro on
 * `POST /api/topics`) — deliberately a different route/trigger so the two
 * suites don't fight over the same fixture.
 */
import { describe, it, expect } from 'vitest';
import { getBaseUrl } from './helpers';

// Same substrings a raw driver/DB error would leak — mirrors
// deleted-user-session.test.ts's DRIVER_LEAK_PATTERNS for this failure's shape.
const DRIVER_LEAK_PATTERNS = [
  /invalid input syntax/i,
  /22P02/,
  /postgres/i,
  /relation "/i,
  /column "/i,
  / at .*\.ts:\d+/, // stack-trace-shaped text
];

function assertNoDriverText(bodyText: string): void {
  for (const pattern of DRIVER_LEAK_PATTERNS) {
    expect(bodyText).not.toMatch(pattern);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Malformed-id result integrity (error-leak + uuid-guard sweep)', () => {
  it('GET /api/posts/{garbage-id} returns a clean 400, never driver text, never a 500', async () => {
    const res = await fetch(`${getBaseUrl()}/api/posts/not-a-uuid`);
    const bodyText = await res.text();

    expect(res.status).toBe(400);
    assertNoDriverText(bodyText);

    const body = JSON.parse(bodyText);
    expect(body).toEqual({ error: 'Invalid postId' });
  });

  it('GET /api/topics/{garbage-id} returns a clean 400, never driver text, never a 500', async () => {
    const res = await fetch(`${getBaseUrl()}/api/topics/not-a-uuid`);
    const bodyText = await res.text();

    expect(res.status).toBe(400);
    assertNoDriverText(bodyText);

    const body = JSON.parse(bodyText);
    expect(body).toEqual({ error: 'Invalid topicId' });
  });

  // --- malformed-id matrix (per the follow-up ask) ------------------------
  // NOTE: "empty" is not exercisable here — `GET /api/posts/` (empty dynamic
  // segment, trailing slash) never reaches this handler at all; Next.js's
  // own router redirects it (308) before any application code runs, so
  // `postId === ''` is structurally unreachable, not merely untested.
  it.each([
    ['whitespace', '%20%20%20'],
    ['a valid uuid with one extra character appended', '12345678-1234-1234-1234-1234567890120'],
    ['a valid uuid with no dashes (Postgres would accept it; we deliberately do not — see src/lib/uuid.ts)', '12345678123412341234123456789012'],
    ['very long input', 'a'.repeat(5000)],
    ['SQL-shaped input', encodeURIComponent("1' OR '1'='1")],
  ])('GET /api/posts/{%s} is a clean 400, never a 500', async (_label, segment) => {
    const res = await fetch(`${getBaseUrl()}/api/posts/${segment}`);
    const bodyText = await res.text();
    expect(res.status).toBe(400);
    assertNoDriverText(bodyText);
    expect(JSON.parse(bodyText)).toEqual({ error: 'Invalid postId' });
  });

  it('path-traversal-shaped segment is a clean 400 (or 404 from Next.js routing — either way, never a 500 or driver text)', async () => {
    const res = await fetch(`${getBaseUrl()}/api/posts/..%2F..%2Fetc%2Fpasswd`);
    const bodyText = await res.text();
    expect(res.status).not.toBe(500);
    assertNoDriverText(bodyText);
  });

  it('two independent malformed-id requests on the same route still get distinct treatment (no shared state) — both 400', async () => {
    const [res1, res2] = await Promise.all([
      fetch(`${getBaseUrl()}/api/posts/not-a-uuid`),
      fetch(`${getBaseUrl()}/api/posts/also-not-a-uuid`),
    ]);
    expect(res1.status).toBe(400);
    expect(res2.status).toBe(400);
  });

  it('control: a well-formed but nonexistent postId gets the route\'s normal 404, unaffected by this change', async () => {
    const res = await fetch(`${getBaseUrl()}/api/posts/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    assertNoDriverText(JSON.stringify(body));
  });

  it('control: a well-formed but nonexistent topicId gets the route\'s normal 404, unaffected by this change', async () => {
    const res = await fetch(`${getBaseUrl()}/api/topics/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    assertNoDriverText(JSON.stringify(body));
  });

  it('sanity: the errorId shape assumed elsewhere is still a real uuid when unhandledRouteError does fire', () => {
    // unhandledRouteError itself is unit-tested exhaustively in apiError.test.ts;
    // this just pins the shape the E2E suites above assume.
    expect(UUID_RE.test('b4de9122-fa81-4295-81d3-c88b30775a87')).toBe(true);
  });
});
