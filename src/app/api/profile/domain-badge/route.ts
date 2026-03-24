import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
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
 *       Returns the user's domain badge opt-in status. A user can have multiple
 *       opted-in domains (e.g., Google Workspace + Microsoft 365 from different orgs).
 *       `domains` contains all publicly visible domains. `availableDomain` is the
 *       most recently verified domain available for opt-in.
 *     operationId: getDomainBadge
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
 *                   description: All publicly visible domains (empty if none opted in)
 *                 availableDomain:
 *                   type: string
 *                   nullable: true
 *                   description: Most recently verified domain available for opt-in (null if no valid verification)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

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
 *       Adds the most recently verified workspace domain to your public badge set.
 *       A user can have multiple domains opted in (e.g., verify company-a.com, opt in,
 *       then verify company-b.com, opt in again — both are shown). Requires a valid
 *       workspace (oidc_domain) verification.
 *     operationId: optInDomainBadge
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
 *       400:
 *         description: No valid workspace verification found
 */
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

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
 *       Workspace verifications remain valid — you can opt back in at any time.
 *     operationId: optOutDomainBadge
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
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let domainToRemove: string | undefined;
  try {
    const body = await request.json();
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
