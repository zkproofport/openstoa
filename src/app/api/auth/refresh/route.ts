import { NextRequest, NextResponse } from 'next/server';
import { getSession, createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { deviceFromRequest } from '@/lib/deviceFromRequest';

const ROUTE = '/api/auth/refresh';

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh JWT session token
 *     description: |
 *       Issues a new Bearer JWT (and refreshes the session cookie) for the currently authenticated
 *       caller. The current token must still be valid — expired tokens cannot be refreshed and
 *       must re-run the full login (`POST /api/auth/challenge` → ZK proof → `POST /api/auth/verify/ai`
 *       for AI agents; `POST /api/auth/proof-request` + polling for native mobile).
 *     operationId: refreshSession
 *     security:
 *       - bearerAuth: []
 *     x-related-skills: [auth-details, cli-auth-flow]
 *     responses:
 *       200:
 *         description: New token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: New JWT token (also set as cookie)
 *                 userId:
 *                   type: string
 *                   description: Authenticated user ID (nullifier)
 *                 nickname:
 *                   type: string
 *                   description: Current nickname (may have changed since last token)
 *                 expiresAt:
 *                   type: number
 *                   description: New token expiry as Unix timestamp (ms)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');

  const session = await getSession(request);
  if (!session) {
    logger.warn(ROUTE, 'No valid session — refresh refused');
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 },
    );
  }

  // Pull fresh user data — nickname may have changed since the previous token was issued
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  if (!user) {
    logger.warn(ROUTE, 'User no longer exists', { userId: session.userId });
    return NextResponse.json(
      { error: 'User not found' },
      { status: 401 },
    );
  }

  /*
   * A REFRESH IS THE SAME SESSION, re-minted.
   *
   * It has to produce a new token — the expiry and the nickname are claims —
   * but nothing about the session changed. Revoking the old record killed the
   * old token, so any request already in flight with it failed, and a second
   * holder was signed out without being told. Re-minting under the same `jti`
   * keeps one record and leaves both tokens working, which is also what stops
   * a phone that refreshes often from looking like several devices.
   */
  /*
   * A SESSION THAT NEVER SAID WHAT IT IS CANNOT BE REFRESHED.
   *
   * `deviceKind` is decided once, by the login route that minted the session,
   * because that is the only moment the server has any grounds for an opinion:
   * afterwards all it has is a header the caller writes. Sessions issued before
   * the claim existed carry no such decision.
   *
   * The old line filled the gap with `'web'` — and, crucially, WROTE that into
   * the new token. Reading a missing claim as `web` at the gate is a safe answer
   * about one request; storing it is a verdict about every request that follows,
   * and one nobody made. A phone whose session predated the claim was therefore
   * not waiting to be recognised: every refresh made it more definitely a
   * browser, for seven more days, and chat stayed 403 until somebody signed out
   * and in by hand. Measured on staging: `/api/topics` 200 while `chat`,
   * `chat/subscribe` and `mls/group-info` were all 403 CHAT_MOBILE_ONLY.
   *
   * Guessing the other way is worse. `deviceFromRequest` reads a header, so
   * adopting the session as `mobile` because it looks like a phone would let any
   * browser holding a pre-claim token into chat by sending one line.
   *
   * So neither guess. Send it back to the one place that can decide — a fresh
   * sign-in. It costs the person one login, once, and it is bounded: no session
   * minted from today lacks the claim, so this branch empties itself.
   *
   * NOT a permanent gate on refresh. The moment every live session carries a
   * kind, this is dead code, and deleting it then is correct.
   */
  if (typeof session.deviceKind !== 'string' && session.isAI !== true) {
    logger.info(ROUTE, 'Refusing to refresh a session with no device kind', {
      userId: session.userId,
    });
    return NextResponse.json(
      {
        error: 'This session predates device identification. Please sign in again.',
        code: 'SESSION_NEEDS_REAUTH',
      },
      { status: 401 },
    );
  }

  const device = deviceFromRequest(request);
  const newToken = await createSession(user.id, user.nickname, {
    sessionId: typeof session.jti === 'string' ? session.jti : undefined,
    isAI: session.isAI === true,
    // The kind is carried over, not re-declared: a refresh is the same client
    // it was at sign-in, and reading the header again would let a session
    // change kind mid-life — a browser refreshing its way into chat.
    deviceKind: session.isAI === true ? 'agent' : session.deviceKind,
    deviceId: device.id,
  });

  // 7 days in ms — must mirror session.ts setExpirationTime('7d')
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const response = NextResponse.json({
    token: newToken,
    userId: user.id,
    nickname: user.nickname,
    expiresAt,
  });

  setSessionCookie(response, newToken);

  logger.info(ROUTE, 'Session refreshed', { userId: user.id });
  return response;
}
