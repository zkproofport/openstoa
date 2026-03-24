import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/session';

/**
 * @openapi
 * /api/auth/session:
 *   get:
 *     tags: [Auth]
 *     summary: Get current session info
 *     description: >-
 *       Returns the current user's session information. Works with both cookie
 *       and Bearer token authentication. Returns `authenticated: false` for
 *       unauthenticated (guest) requests — never returns 401.
 *     operationId: getSession
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

    logger.info(ROUTE, 'Session valid', { userId: session.userId, nickname: session.nickname, totalRecorded, role });
    return NextResponse.json({
      userId: session.userId,
      nickname: session.nickname,
      verifiedAt: session.verifiedAt,
      totalRecorded,
      ...(role === 'admin' ? { role } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
