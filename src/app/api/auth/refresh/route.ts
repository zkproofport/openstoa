import { NextRequest, NextResponse } from 'next/server';
import { getSession, createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/refresh';

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh JWT session token
 *     description: >-
 *       Issues a new JWT for the currently authenticated session. Used by native mobile clients
 *       to extend their session before the 7-day expiry. Web clients can also call this and the
 *       cookie will be reset. The current token must still be valid (not expired) — expired tokens
 *       must use the standard auth flow (proof-request + poll).
 *     operationId: refreshSession
 *     security:
 *       - bearerAuth: []
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

  const newToken = await createSession(user.id, user.nickname, {
    isAI: session.isAI === true,
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
