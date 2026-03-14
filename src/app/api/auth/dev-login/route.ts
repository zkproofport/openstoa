import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/dev-login';

/**
 * Dev-only auth endpoint for E2E testing.
 * Creates a test user with a random ID and returns a Bearer token.
 * ONLY available when APP_ENV !== 'production'.
 */
export async function POST(request: NextRequest) {
  if (process.env.APP_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 404 });
  }

  logger.info(ROUTE, 'Dev login request');

  try {
    const body = await request.json().catch(() => ({}));
    const nickname = body.nickname || `dev_user_${randomBytes(4).toString('hex')}`;
    const userId = `0x${randomBytes(32).toString('hex')}`;

    // Create user in DB
    const existing = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!existing) {
      await db.insert(users).values({ id: userId, nickname });
    }

    const token = await createSession(userId, nickname);

    logger.info(ROUTE, 'Dev user created', { userId, nickname });

    return NextResponse.json({ userId, nickname, token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
