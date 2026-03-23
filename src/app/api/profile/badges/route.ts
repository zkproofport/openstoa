import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getActiveVerificationsCache } from '@/lib/verification-cache';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/badges';

/**
 * @openapi
 * /api/profile/badges:
 *   get:
 *     tags: [Profile]
 *     summary: Get user's active verification badges
 *     description: >-
 *       Returns all active (non-expired) verification badges for the authenticated user.
 *       Verification data is stored in Redis cache only (30-day TTL) — no personal
 *       information is persisted in the database.
 *     operationId: getUserBadges
 *     responses:
 *       200:
 *         description: Active badges
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const verifications = await getActiveVerificationsCache(session.userId);
  const badges = verifications.map(v => ({
    type: v.proofType,
    verifiedAt: v.record.verifiedAt,
    expiresAt: v.record.expiresAt,
  }));
  return NextResponse.json({ badges });
}
