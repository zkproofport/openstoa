import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const ROUTE = '/api/test/clear-verification-cache';

/**
 * Admin-only endpoint: clears verification cache for the authenticated user.
 * Requires admin role in DB — safe for all environments.
 *
 * Query params:
 *   ?type=kyc|country|oidc_domain|oidc_login  (clear specific type)
 *   (no type) → clear all
 *
 * Note: domain_badge is no longer a separate key — it lives inside the oidc_domain record.
 * Clearing oidc_domain automatically clears shown domains.
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Admin check
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
    columns: { role: true },
  });
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  const prefix = 'community:verification';
  const cacheTypes = ['kyc', 'country', 'oidc_domain', 'oidc_login'];

  if (type) {
    if (cacheTypes.includes(type)) {
      await redis.del(`${prefix}:${session.userId}:${type}`);
      logger.info(ROUTE, 'Cleared verification cache', { userId: session.userId, type });
    } else {
      return NextResponse.json({ error: `Invalid type: ${type}` }, { status: 400 });
    }
    return NextResponse.json({ success: true, cleared: type });
  }

  // Clear all
  const keys = cacheTypes.map(ct => `${prefix}:${session.userId}:${ct}`);
  await redis.del(...keys);
  logger.info(ROUTE, 'Cleared all verification caches', { userId: session.userId, count: keys.length });

  return NextResponse.json({ success: true, cleared: 'all' });
}
