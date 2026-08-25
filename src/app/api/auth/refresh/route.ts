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
  const device = deviceFromRequest(request);
  const newToken = await createSession(user.id, user.nickname, {
    sessionId: typeof session.jti === 'string' ? session.jti : undefined,
    isAI: session.isAI === true,
    // The kind is carried over, not re-declared: a refresh is the same client
    // it was at sign-in, and reading the header again would let a session
    // change kind mid-life — a browser refreshing its way into chat.
    deviceKind: session.deviceKind ?? (session.isAI === true ? 'agent' : 'web'),
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
