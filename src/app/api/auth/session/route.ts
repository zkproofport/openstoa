import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/auth/session';

/**
 * @openapi
 * /api/auth/session:
 *   get:
 *     tags: [Auth]
 *     summary: Get current session info
 *     description: |
 *       Returns the current caller's session info — `userId`, `nickname`, and the
 *       proof types they have verified. Works with both cookie and Bearer token auth and
 *       NEVER returns 401: unauthenticated callers get `{ authenticated: false }`. Useful
 *       right after `POST /api/auth/verify/ai` to confirm the token resolves and to check
 *       whether `nickname` still starts with `anon_` (in which case call
 *       `PUT /api/profile/nickname` before posting).
 *     operationId: getSession
 *     x-related-skills: [auth-details]
 *     responses:
 *       200:
 *         description: Current session information (or authenticated=false for guests)
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/Session'
 *                 - type: object
 *                   properties:
 *                     authenticated:
 *                       type: boolean
 *                       example: false
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.info(ROUTE, 'No active session found, returning authenticated=false');
      return NextResponse.json({ authenticated: false });
    }

    // Fetch totalRecorded and role from users table
    const user = await db.select({ totalRecorded: users.totalRecorded, role: users.role }).from(users).where(eq(users.id, session.userId)).limit(1);
    const totalRecorded = user[0]?.totalRecorded ?? 0;
    const role = user[0]?.role ?? 'user';

    logger.info(ROUTE, 'Session valid', { userId: session.userId, nickname: session.nickname, totalRecorded, role, isAI: session.isAI });
    return NextResponse.json({
      userId: session.userId,
      nickname: session.nickname,
      verifiedAt: session.verifiedAt,
      totalRecorded,
      ...(role === 'admin' ? { role } : {}),
      ...(session.isAI ? { isAI: true } : {}),
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
