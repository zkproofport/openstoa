import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { requireAiCapability } from '@/lib/aiPermissions';
import { getAvailableDomain, getShownDomains, setDomainShown, clearShownDomains } from '@/lib/verification-cache';
import { logger } from '@/lib/logger';

const ROUTE = '/api/profile/domain-badge';

/**
 * @openapi
 * /api/profile/domain-badge:
 *   get:
 *     tags: [Profile]
 *     summary: Get domain badge status
 *     description: >-
 *       Returns the user's current workspace domain visibility. Verified workspace
 *       domains are public by default unless the user has explicitly hidden the badge.
 *       `domains` contains all publicly visible domains. `availableDomain` is the
 *       currently verified domain, including when its badge is hidden.
 *     operationId: getDomainBadge
 *     x-related-skills: [opt-in-domain-badge, opt-out-domain-badge, topic-proofs]
 *     responses:
 *       200:
 *         description: Domain badge status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 domains:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Currently visible verified domain (empty when hidden or expired)
 *                 availableDomain:
 *                   type: string
 *                   nullable: true
 *                   description: Currently verified domain (null if no valid verification)
 *       403:
 *         description: AI caller lacks /openstoa/profile/read capability
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/domain-badge');
  if (authorizationError) return authorizationError;

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const readGate = await requireAiCapability(db, session, '/openstoa/profile/read');
  if (readGate) return readGate;

  const [currentDomains, availableDomain] = await Promise.all([
    getShownDomains(session.userId),
    getAvailableDomain(session.userId),
  ]);

  return NextResponse.json({
    domains: currentDomains,
    availableDomain,
  });
}

/**
 * @openapi
 * /api/profile/domain-badge:
 *   post:
 *     tags: [Profile]
 *     summary: Opt in to domain badge
 *     description: >-
 *       Shows the currently verified workspace domain. Uses the same persistent
 *       oidc_domain visibility preference as PATCH /api/profile/badges. Requires
 *       an active workspace verification; previously verified domains are not disclosed.
 *     operationId: optInDomainBadge
 *     x-related-skills: [get-domain-badge, opt-out-domain-badge, topic-proofs]
 *     responses:
 *       200:
 *         description: Domain badge added
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 domain:
 *                   type: string
 *                   description: The domain just added
 *                 domains:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: All currently visible domains
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: AI caller lacks /openstoa/profile/edit capability
 *       400:
 *         description: No valid workspace verification found
 */
export async function POST(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/domain-badge');
  if (authorizationError) return authorizationError;

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const editGate = await requireAiCapability(db, session, '/openstoa/profile/edit');
  if (editGate) return editGate;

  const domain = await getAvailableDomain(session.userId);
  if (!domain) {
    logger.warn(ROUTE, 'Opt-in attempted without workspace verification', { userId: session.userId });
    return NextResponse.json(
      { error: 'No valid workspace verification found. Complete a workspace proof first.' },
      { status: 400 },
    );
  }

  await setDomainShown(session.userId, domain, true);
  const allDomains = await getShownDomains(session.userId);
  logger.info(ROUTE, 'Domain badge opt-in', { userId: session.userId, domain, totalDomains: allDomains.length });

  return NextResponse.json({ success: true, domain, domains: allDomains });
}

/**
 * @openapi
 * /api/profile/domain-badge:
 *   delete:
 *     tags: [Profile]
 *     summary: Opt out of domain badge
 *     description: >-
 *       Removes a domain from the public badge set. Send `{ "domain": "company.com" }`
 *       to remove a specific domain. Send no body to remove all domains.
 *       Workspace verification remains valid. The hidden preference persists through
 *       re-verification and expiry, until explicitly enabled again.
 *     operationId: optOutDomainBadge
 *     x-related-skills: [get-domain-badge, opt-in-domain-badge]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               domain:
 *                 type: string
 *                 description: Specific domain to remove. Omit to remove all domains.
 *     responses:
 *       200:
 *         description: Domain badge(s) removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 domains:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Remaining visible domains after removal
 *       403:
 *         description: AI caller lacks /openstoa/profile/edit capability
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function DELETE(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/profile/domain-badge');
  if (authorizationError) return authorizationError;

  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const editGate = await requireAiCapability(db, session, '/openstoa/profile/edit');
  if (editGate) return editGate;

  let domainToRemove: string | undefined;
  try {
    const body = await request.json();
    if (body?.domain !== undefined && typeof body.domain !== 'string') {
      return NextResponse.json({ error: 'domain must be a string' }, { status: 400 });
    }
    domainToRemove = body?.domain;
  } catch {
    // No body — remove all
  }

  if (domainToRemove) {
    await setDomainShown(session.userId, domainToRemove, false);
  } else {
    await clearShownDomains(session.userId);
  }
  const remaining = await getShownDomains(session.userId);
  logger.info(ROUTE, 'Domain badge opt-out', { userId: session.userId, removed: domainToRemove ?? 'all', remaining: remaining.length });

  return NextResponse.json({ success: true, domains: remaining });
}
