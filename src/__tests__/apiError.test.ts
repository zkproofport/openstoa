import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoggerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/test-route';

/**
 * Edge-case matrix for `unhandledRouteError` (the shared catch-all helper).
 * See report for the matching per-row disposition — every row here maps
 * 1:1 to a test below, or is marked N/A in the report with a one-line reason.
 */
describe('unhandledRouteError', () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  // --- boundary -------------------------------------------------------
  it('handles an Error with an empty message', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', new Error(''));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(typeof body.errorId).toBe('string');
    expect(body.errorId.length).toBeGreaterThan(0);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [, , data] = mockLoggerError.mock.calls[0];
    expect(data.error).toBe('');
    expect(data.errorId).toBe(body.errorId);
  });

  it('handles a non-Error thrown value: a plain string', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', 'raw string throw');
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError.mock.calls[0][2].error).toBe('raw string throw');
  });

  it('handles a non-Error thrown value: null', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', null);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError.mock.calls[0][2].error).toBe('null');
  });

  it('handles a non-Error thrown value: a plain object', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', { code: 'ECONNREFUSED' });
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    // String(obj) => "[object Object]" — never crashes, never leaks the shape.
    expect(mockLoggerError.mock.calls[0][2].error).toBe('[object Object]');
  });

  // --- empty / whitespace-only / null / undefined (kept distinct) -----
  it('handles an Error whose message is whitespace-only', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', new Error('   '));
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError.mock.calls[0][2].error).toBe('   ');
  });

  it('handles a thrown undefined', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', undefined);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError.mock.calls[0][2].error).toBe('undefined');
  });

  // --- hostile input ----------------------------------------------------
  it('never leaks SQL-shaped driver text into the client response', async () => {
    const driverMessage =
      'insert or update on table "topics" violates foreign key constraint "topics_creator_id_users_id_fk"';
    const res = unhandledRouteError(ROUTE, 'POST', new Error(driverMessage));
    const body = await res.json();
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain('topics_creator_id_users_id_fk');
    expect(bodyText).not.toContain('table');
    expect(bodyText).not.toContain('constraint');
    // ...but the full message reached the server log, untruncated.
    expect(mockLoggerError.mock.calls[0][2].error).toBe(driverMessage);
  });

  it('never leaks a file path into the client response', async () => {
    const res = unhandledRouteError(
      ROUTE,
      'POST',
      new Error('ENOENT: no such file or directory, open \'/etc/secrets/db.env\'')
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('/etc/secrets');
  });

  it('never leaks a token-shaped string into the client response', async () => {
    const res = unhandledRouteError(
      ROUTE,
      'POST',
      new Error('upstream 401: invalid credential sk_live_abcdef1234567890')
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('sk_live_abcdef1234567890');
  });

  it('never leaks the stack trace into the client response', async () => {
    const err = new Error('boom');
    const res = unhandledRouteError(ROUTE, 'POST', err);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('at ');
    expect(JSON.stringify(body)).not.toContain(__filename);
    // ...but the stack IS in the server log.
    expect(mockLoggerError.mock.calls[0][2].stack).toBe(err.stack);
  });

  // --- UTF-8 ------------------------------------------------------------
  it('logs Korean and emoji error text in full without corrupting the client response', async () => {
    const msg = '데이터베이스 연결 실패 🔥 (연결 시간 초과)';
    const res = unhandledRouteError(ROUTE, 'POST', new Error(msg));
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('데이터베이스');
    expect(mockLoggerError.mock.calls[0][2].error).toBe(msg);
  });

  // --- very large input ---------------------------------------------------
  it('caps an oversized driver payload in the log rather than writing it unbounded', async () => {
    const huge = 'x'.repeat(5_000_000); // 5MB — simulates a bulk statement echoed back by a driver
    const res = unhandledRouteError(ROUTE, 'POST', new Error(huge));
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body).length).toBeLessThan(1000); // response never grows with the error
    const loggedError = mockLoggerError.mock.calls[0][2].error as string;
    expect(loggedError.length).toBeLessThan(huge.length); // capped, not silently dropped
    expect(loggedError.startsWith('x'.repeat(100))).toBe(true); // real content preserved up to the cap
    expect(loggedError).toContain('truncated');
  });

  // --- authorization ------------------------------------------------------
  // N/A: this helper is the UNHANDLED catch-all only. 401/403 authorization
  // responses are deliberate product copy returned BEFORE the catch-all (see
  // route-level tests) and never pass through this helper.

  // --- race / fire-and-forget ---------------------------------------------
  it('concurrent calls each get their own errorId with no shared state', async () => {
    const [r1, r2, r3] = await Promise.all([
      unhandledRouteError(ROUTE, 'POST', new Error('a')),
      unhandledRouteError(ROUTE, 'POST', new Error('b')),
      unhandledRouteError(ROUTE, 'POST', new Error('c')),
    ]);
    const [b1, b2, b3] = await Promise.all([r1.json(), r2.json(), r3.json()]);
    const ids = new Set([b1.errorId, b2.errorId, b3.errorId]);
    expect(ids.size).toBe(3);
  });

  // --- contract invocation --------------------------------------------
  // Covered by apiErrorSweep.test.ts, which asserts every converted route's
  // catch-all calls unhandledRouteError (not just this direct-call suite).

  // --- result integrity -----------------------------------------------
  it('response body contains exactly { error, errorId } — no extra fields leaking data', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', new Error('anything'));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'errorId']);
  });

  it('preserves the action label and route in the server log message', async () => {
    unhandledRouteError('/api/topics', 'PATCH', new Error('x'));
    const [route, message] = mockLoggerError.mock.calls[0];
    expect(route).toBe('/api/topics');
    expect(message).toBe('Unhandled error in PATCH');
  });

  it('attaches optional extra context to the server log only, never to the response', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', new Error('x'), 500, { postId: 'post-123' });
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'errorId']);
    expect(mockLoggerError.mock.calls[0][2].postId).toBe('post-123');
  });

  it('supports a custom status while keeping the generic body shape', async () => {
    const res = unhandledRouteError(ROUTE, 'POST', new Error('x'), 502);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toBe('Internal server error');
  });

  // --- external dependency failure ----------------------------------------
  it('turns a Redis-down error into a generic response with full detail logged', async () => {
    const res = unhandledRouteError(ROUTE, 'GET', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('6379');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(mockLoggerError.mock.calls[0][2].error).toContain('ECONNREFUSED');
  });
});
