/**
 * A refusal says WHY in a form a program can act on.
 *
 * THE GAP THIS CLOSES. Every refusal used to be a sentence and nothing else:
 *
 *     { "error": "Invalid session" }
 *
 * `error` is written for a person. It gets translated, reworded and shortened,
 * so nothing may branch on it — which left a client with no way to tell apart
 * the only two answers that matter: keep this credential and try again, or
 * throw it away and ask the person to sign in.
 *
 * That gap is what let the chat stream retry a dead token forever. The server
 * said no, correctly, on every attempt; the client had nothing to act on, so it
 * kept knocking and the person watched "Reconnecting…" that never cleared.
 *
 * TWO CODES, NOT ONE, and the distinction is the point:
 *
 *   no-credential    nothing was sent. A guest has not signed in; telling them
 *                    their session died would be a lie about something that
 *                    never existed.
 *   credential-dead  a token was read and REFUSED — expired, or signed with a
 *                    key this server does not accept. Re-sending it will never
 *                    work, so a client that keeps it is knocking on a door
 *                    that cannot open.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: revoke anything based on a refusal. A
 * request whose signature failed cannot be attributed — believing the user id
 * inside it would let anyone log anyone else out by sending rubbish with their
 * id in it. Codes are reported, sessions are not destroyed.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a request with no credential is answered `no-credential`
 *   contract   → a request with a bad credential is answered `credential-dead`
 *   integrity  → the two are never the same value; a client can branch
 *   integrity  → the browser cookie is cleared on the dead-credential path and
 *                NOT on the no-credential one, which has nothing to clear
 *   hostile    → the human sentence may change freely; the code may not, so the
 *                assertions are on the code and the sentence is only required
 *                to exist
 *   累積       → ten refusals in a row all carry the code; nothing latches or
 *                degrades to a bare sentence after the first
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

beforeAll(() => {
  /*
   * The middleware throws without this rather than answering — a deliberate
   * refusal to run half-configured. Same value the session tests use.
   */
  process.env.COMMUNITY_JWT_SECRET =
    process.env.COMMUNITY_JWT_SECRET ?? 'test-secret-key-for-jwt-signing-minimum-length';
});

/**
 * A request the middleware itself refuses.
 *
 * NOT a chat path, and finding that out cost a detour worth writing down:
 * `GUEST_ACCESSIBLE_PREFIXES` contains `/api/topics`, and the check is
 * `startsWith`, so everything beneath it — including
 * `/api/topics/{id}/chat/subscribe` — passes the middleware without a token and
 * is refused by the route instead. Not a hole (the route calls `getSession` and
 * answers 401), but it means a chat URL cannot exercise the middleware's own
 * refusal. `/api/me/events` has no guest prefix and is the honest choice.
 */
function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3200/api/me/events', { headers });
}

async function refusal(headers?: Record<string, string>) {
  const res = await middleware(req(headers));
  const body = (await res.clone().json()) as { error?: string; code?: string };
  return { status: res.status, body, res };
}

describe('a refusal carries a code a program can read', () => {
  it('CONTRACT: nothing sent → no-credential', async () => {
    const { status, body } = await refusal();
    expect(status).toBe(401);
    expect(body.code).toBe('no-credential');
    // The sentence still exists for a person to read; it is simply not the
    // thing anything branches on.
    expect(typeof body.error).toBe('string');
    expect(body.error).toBeTruthy();
  });

  it('CONTRACT: a token that fails verification → credential-dead', async () => {
    const { status, body } = await refusal({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.not-a-real-signature',
    });
    expect(status).toBe(401);
    expect(body.code).toBe('credential-dead');
  });

  it('INTEGRITY: the two answers are distinguishable', async () => {
    /*
     * The whole reason for a code. If both refusals said the same thing, a
     * client would have to choose one behaviour for both — and either it
     * discards a guest's non-existent session, or it keeps hammering with a
     * dead one. Both were shipped at some point.
     */
    const absent = await refusal();
    const dead = await refusal({ authorization: 'Bearer rubbish.rubbish.rubbish' });

    expect(absent.body.code).not.toBe(dead.body.code);
  });

  it('INTEGRITY: only the dead-credential path clears the browser cookie', async () => {
    // There is nothing to clear when nothing was sent, and setting an empty
    // cookie on a guest request would churn a header for no reason.
    const dead = await refusal({ authorization: 'Bearer rubbish.rubbish.rubbish' });
    const absent = await refusal();

    expect(dead.res.headers.get('set-cookie') ?? '').toContain('zk-community-session');
    expect(absent.res.headers.get('set-cookie') ?? '').not.toContain('zk-community-session');
  });

  it('ACCUMULATING: ten refusals in a row all carry the code', async () => {
    /*
     * THE AXIS. A code attached once — on the first refusal, or lost after a
     * cached response — leaves a client blind exactly when it is retrying,
     * which is the only time it needs the answer.
     */
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await refusal({ authorization: 'Bearer rubbish.rubbish.rubbish' })).body.code);
    }

    expect(codes).toEqual(Array(10).fill('credential-dead'));
  });
});
