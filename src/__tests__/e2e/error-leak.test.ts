/**
 * Result-integrity E2E for the shared `unhandledRouteError` catch-all helper
 * (`src/lib/apiError.ts`) — a real HTTP round trip against a real container,
 * forcing a genuine unhandled failure and asserting the response body is
 * clean.
 *
 * Forced failure: `GET /api/posts/{postId}` and `GET /api/topics/{topicId}`
 * bind the path param straight into a Drizzle `eq(<uuid column>, postId)`
 * with no UUID-format pre-check, so a garbage-shaped id makes Postgres
 * reject the query with `22P02 invalid input syntax for type uuid` — a
 * genuine driver error, reachable over plain HTTP with no DB access needed.
 * Deliberately a DIFFERENT forced failure than `deleted-user-session.test.ts`
 * (S-2's FK-violation repro on `POST /api/topics`), to avoid two E2E suites
 * fighting over the same route.
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

describe('Unhandled-error result integrity (error-leak sweep)', () => {
  it('GET /api/posts/{garbage-id} returns a generic 500 with a correlation id, never driver text', async () => {
    const res = await fetch(`${getBaseUrl()}/api/posts/not-a-uuid`);
    const bodyText = await res.text();

    expect(res.status).toBe(500);
    assertNoDriverText(bodyText);

    const body = JSON.parse(bodyText);
    expect(Object.keys(body).sort()).toEqual(['error', 'errorId']);
    expect(body.error).toBe('Internal server error');
    expect(typeof body.errorId).toBe('string');
    expect(UUID_RE.test(body.errorId)).toBe(true);
  });

  it('GET /api/topics/{garbage-id} returns a generic 500 with a correlation id, never driver text', async () => {
    const res = await fetch(`${getBaseUrl()}/api/topics/not-a-uuid`);
    const bodyText = await res.text();

    expect(res.status).toBe(500);
    assertNoDriverText(bodyText);

    const body = JSON.parse(bodyText);
    expect(Object.keys(body).sort()).toEqual(['error', 'errorId']);
    expect(body.error).toBe('Internal server error');
  });

  it('two independent failures on the same route get different correlation ids', async () => {
    const [res1, res2] = await Promise.all([
      fetch(`${getBaseUrl()}/api/posts/not-a-uuid`),
      fetch(`${getBaseUrl()}/api/posts/also-not-a-uuid`),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    expect(body1.errorId).not.toBe(body2.errorId);
  });

  it('control: a well-formed but nonexistent postId gets the route\'s normal 404, unaffected by this change', async () => {
    const res = await fetch(`${getBaseUrl()}/api/posts/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    assertNoDriverText(JSON.stringify(body));
  });
});
