import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { requireAiCapability } from '@/lib/aiPermissions';
import { getProfileBadges, getUserBadges, isBadgeType, setBadgeVisibility } from '@/lib/verification-cache';
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
 *       Includes hidden badges with a `visible` boolean for owner controls; workspace
 *       badges include the currently verified `domain` when available. New verifications
 *       are visible by default. Visibility preferences survive verification expiry.
 *       Verification data is stored in Redis cache only (30-day TTL) — no personal
 *       information is persisted in the database.
 *     operationId: getUserBadges
 *     x-related-skills: [topic-proofs, get-domain-badge]
 *     responses:
 *       200:
 *         description: Active badges including their visibility preference
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 publicBadges:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PublicBadge'
 *                 badges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [type, verifiedAt, expiresAt, visible]
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [kyc, country, oidc_domain, oidc_login]
 *                       verifiedAt:
 *                         type: integer
 *                         description: Unix timestamp in milliseconds
 *                       expiresAt:
 *                         type: integer
 *                         description: Unix timestamp in milliseconds
 *                       visible:
 *                         type: boolean
 *                       domain:
 *                         type: string
 *                         description: Currently verified workspace domain, when available
 *       403:
 *         description: AI caller lacks /openstoa/profile/read capability
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/badges');
  if (authorizationError) return authorizationError;

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const readGate = await requireAiCapability(db, session, '/openstoa/profile/read');
  if (readGate) return readGate;
  const badges = await getProfileBadges(session.userId);
  return NextResponse.json({ badges, userId: session.userId, publicBadges: await getUserBadges(session.userId) });
}

/**
 * @openapi
 * /api/profile/badges:
 *   patch:
 *     tags: [Profile]
 *     summary: Set a verification badge's public visibility
 *     description: >-
 *       Requires an active verification of the selected type. Visibility defaults
 *       to true and an explicit choice persists through re-verification and expiry.
 *       Hiding a badge does not affect proof eligibility or topic membership.
 *     operationId: setBadgeVisibility
 *     x-related-skills: [get-user-badges, get-domain-badge, topic-proofs]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, visible]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [kyc, country, oidc_domain, oidc_login]
 *               visible:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Visibility preference saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, type, visible]
 *               properties:
 *                 userId:
 *                   type: string
 *                 publicBadges:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PublicBadge'
 *                 success:
 *                   type: boolean
 *                 type:
 *                   type: string
 *                   enum: [kyc, country, oidc_domain, oidc_login]
 *                 visible:
 *                   type: boolean
 *       403:
 *         description: AI caller lacks /openstoa/profile/edit capability
 *       400:
 *         description: Malformed JSON, unsupported type, missing boolean visibility, or no active verification
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function PATCH(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/badges');
  if (authorizationError) return authorizationError;

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const editGate = await requireAiCapability(db, session, '/openstoa/profile/edit');
  if (editGate) return editGate;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('type' in body) || !isBadgeType(body.type)
      || !('visible' in body) || typeof body.visible !== 'boolean') {
    return NextResponse.json({ error: 'A supported badge type and boolean visible are required' }, { status: 400 });
  }
  const { type, visible } = body;
  if (!await setBadgeVisibility(session.userId, type, visible)) {
    return NextResponse.json({ error: 'No active verification found for this badge type' }, { status: 400 });
  }
  logger.info(ROUTE, 'Badge visibility updated', { userId: session.userId, type, visible });
  return NextResponse.json({ success: true, type, visible, userId: session.userId, publicBadges: await getUserBadges(session.userId) });
}
