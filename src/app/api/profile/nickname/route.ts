import { NextRequest, NextResponse } from 'next/server';
import { getSession, createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/nickname';

const NICKNAME_REGEX = /^[a-zA-Z0-9_]{2,20}$/;

/**
 * @openapi
 * /api/profile/nickname:
 *   put:
 *     tags: [Profile]
 *     summary: Set or update nickname
 *     description: >-
 *       Sets or updates the user's display nickname. Required after first login. Must be 2-20
 *       characters, alphanumeric and underscores only. Reissues the session cookie/token with
 *       the updated nickname.
 *     operationId: setNickname
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nickname]
 *             properties:
 *               nickname:
 *                 type: string
 *                 pattern: "^[a-zA-Z0-9_]{2,20}$"
 *                 description: Display name (2-20 chars, alphanumeric + underscore)
 *     responses:
 *       200:
 *         description: Nickname updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nickname:
 *                   type: string
 *                   description: The updated nickname
 *       400:
 *         description: Invalid nickname format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: Nickname already taken
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error409'
 */
export async function PUT(request: NextRequest) {
  logger.info(ROUTE, 'PUT request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { nickname } = body;

    if (!nickname || typeof nickname !== 'string') {
      logger.warn(ROUTE, 'Missing or invalid nickname field', { userId: session.userId });
      return NextResponse.json(
        { error: 'Nickname is required' },
        { status: 400 },
      );
    }

    if (!NICKNAME_REGEX.test(nickname)) {
      logger.warn(ROUTE, 'Nickname failed validation', { userId: session.userId, nickname });
      return NextResponse.json(
        { error: 'Nickname must be 2-20 characters, alphanumeric and underscore only' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Updating nickname', { userId: session.userId, nickname });

    try {
      await db
        .update(users)
        .set({ nickname })
        .where(eq(users.id, session.userId));
    } catch (error: unknown) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        logger.warn(ROUTE, 'Nickname already taken', { userId: session.userId, nickname });
        return NextResponse.json(
          { error: 'Nickname already taken' },
          { status: 409 },
        );
      }
      throw error;
    }

    logger.info(ROUTE, 'Nickname updated, reissuing JWT', { userId: session.userId, nickname });

    // Reissue JWT with new nickname
    const token = await createSession(session.userId, nickname);
    const response = NextResponse.json({ nickname });
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
