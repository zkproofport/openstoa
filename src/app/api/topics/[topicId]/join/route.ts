import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, joinRequests } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  extractScope,
  extractIsIncluded,
  extractCountryList,
  extractDomain,
  computeScopeHash,
  normalizePublicInputs,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { hasValidVerificationCache, saveVerificationCache, circuitToCacheType } from '@/lib/verification-cache';
import { buildProofRequirement } from '@/lib/proof-guides';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/join';

/**
 * @openapi
 * /api/topics/{topicId}/join:
 *   post:
 *     tags: [Topics]
 *     summary: Join or request to join topic
 *     description: >-
 *       Requests to join a topic. For public topics, joins immediately. For private topics, creates
 *       a pending join request that must be approved by a topic owner or admin. Secret topics cannot
 *       be joined directly (use invite code). Country-gated topics require a valid ZK proof.
 *     operationId: joinTopic
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID to join
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Required only if topic requires country proof
 *             properties:
 *               proof:
 *                 type: string
 *                 description: Country attestation proof hex string
 *               publicInputs:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Proof public inputs as hex strings
 *     responses:
 *       201:
 *         description: Joined public topic immediately
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Join success indicator
 *       202:
 *         description: Join request created for private topic (pending approval)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Request creation success
 *                 status:
 *                   type: string
 *                   example: pending
 *                   description: Join request status
 *                 message:
 *                   type: string
 *                   description: Human-readable status message
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       402:
 *         description: >-
 *           Proof required to join this topic. Response includes full proof generation guide with
 *           CLI commands, payment info (0.1 USDC via x402), challenge endpoint, and step-by-step
 *           instructions for both mobile app and AI agent workflows.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Proof required to join this topic
 *                 proofRequirement:
 *                   type: object
 *                   description: >-
 *                     Complete proof generation guide. Includes payment options (PAYMENT_KEY wallet
 *                     or CDP managed wallet), challenge endpoint (POST /api/auth/challenge),
 *                     CLI prove commands (zkproofport-prove), and join endpoint details.
 *                   properties:
 *                     type:
 *                       type: string
 *                       description: >-
 *                         Proof type required. kyc=Coinbase KYC, country=Coinbase Country,
 *                         google_workspace=Google Workspace domain, microsoft_365=Microsoft 365 domain,
 *                         workspace=either Google or Microsoft
 *                       enum: [kyc, country, google_workspace, microsoft_365, workspace]
 *                     circuit:
 *                       type: string
 *                       description: ZK circuit used (coinbase_attestation, coinbase_country_attestation, or oidc_domain_attestation)
 *                     domain:
 *                       type: string
 *                       nullable: true
 *                       description: Required email domain (e.g., company.com). Null if any domain accepted.
 *                     allowedCountries:
 *                       type: array
 *                       nullable: true
 *                       items:
 *                         type: string
 *                       description: ISO 3166-1 alpha-2 country codes (for country proof type)
 *                     payment:
 *                       type: object
 *                       description: Payment info — 0.1 USDC per proof via x402 protocol
 *                       properties:
 *                         cost:
 *                           type: string
 *                           example: 0.1 USDC per proof
 *                         options:
 *                           type: array
 *                           description: Payment wallet (PAYMENT_KEY) or CDP managed wallet
 *                           items:
 *                             type: object
 *                             properties:
 *                               name:
 *                                 type: string
 *                               envVars:
 *                                 type: object
 *                     guide:
 *                       type: object
 *                       description: Step-by-step instructions for mobile and agent workflows with CLI commands
 *                     guideUrl:
 *                       type: string
 *                       description: URL to full proof guide (e.g., /api/docs/proof-guide/kyc)
 *                     proofEndpoint:
 *                       type: object
 *                       description: Endpoints for proof generation (mobile relay + agent challenge/prove/join flow)
 *       403:
 *         description: Secret topic (use invite code) or country not in allowed list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       409:
 *         description: Already a member or join request already pending
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error409'
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    logger.info(ROUTE, 'Join attempt', { userId: session.userId, topicId });

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Check if already a member
    const existingMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (existingMembership) {
      logger.warn(ROUTE, 'User is already a member', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Already a member of this topic' },
        { status: 409 },
      );
    }

    // Determine effective proof type
    const effectiveProofType = topic.proofType || (topic.requiresCountryProof ? 'country' : 'none');

    if (effectiveProofType !== 'none') {
      logger.info(ROUTE, 'Topic requires proof', { userId: session.userId, topicId, proofType: effectiveProofType });

      const requiredDomain = topic.requiredDomain ?? undefined;

      // Check Redis verification cache (all OIDC types map to same cache key)
      const alreadyVerified = await hasValidVerificationCache(
        session.userId,
        effectiveProofType,
        (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace')
          ? requiredDomain : undefined,
      );

      // Try to read proof from request body
      let body: Record<string, unknown> = {};
      try {
        body = await request.json();
      } catch {
        // No body provided
      }
      const { proof, publicInputs } = body as { proof?: string; publicInputs?: string[] };

      // Validate proof data format
      if (proof !== undefined) {
        if (typeof proof !== 'string' || proof.trim() === '') {
          return NextResponse.json({ error: 'Invalid proof: must be a non-empty string' }, { status: 400 });
        }
      }
      if (publicInputs !== undefined) {
        if (typeof publicInputs !== 'string' || publicInputs.trim() === '') {
          return NextResponse.json({ error: 'Invalid publicInputs: must be a non-empty string' }, { status: 400 });
        }
      }

      // If proof is provided, always verify and refresh cache (ensures domain field is stored)
      if (proof && publicInputs) {
        // Normalize publicInputs (SDK may return single hex string instead of array)
        const normalizedInputs = normalizePublicInputs(publicInputs);

        // Verify scope matches community scope
        const circuitId = effectiveProofType === 'country' ? 'coinbase_country_attestation'
          : effectiveProofType === 'kyc' ? 'coinbase_attestation'
          : 'oidc_domain_attestation'; // workspace, google_workspace, microsoft_365 all use oidc
        const scope = extractScope(normalizedInputs, circuitId);
        const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
        if (scope !== expectedScope) {
          logger.warn(ROUTE, 'Proof scope mismatch', { userId: session.userId, topicId, scope, expectedScope });
          return NextResponse.json(
            { error: 'Proof scope mismatch' },
            { status: 400 },
          );
        }

        // Type-specific verification
        if (effectiveProofType === 'country') {
          const isIncluded = extractIsIncluded(normalizedInputs, 'coinbase_country_attestation');
          if (!isIncluded) {
            logger.warn(ROUTE, 'Country not in allowed list', { userId: session.userId, topicId });
            return NextResponse.json({ error: 'Country not allowed for this topic' }, { status: 403 });
          }

          // Verify the proof's country_list matches the topic's allowedCountries
          const topicCountries = topic.allowedCountries || [];
          if (topicCountries.length > 0) {
            const proofCountryList = extractCountryList(normalizedInputs, 'coinbase_country_attestation');
            const proofSet = new Set(proofCountryList.map(c => c.toUpperCase()));
            const topicSet = new Set(topicCountries.map(c => c.toUpperCase()));
            if (proofSet.size !== topicSet.size || ![...proofSet].every(c => topicSet.has(c))) {
              logger.warn(ROUTE, 'Country list mismatch', {
                userId: session.userId, topicId,
                proofCountries: proofCountryList,
                topicCountries,
              });
              return NextResponse.json(
                { error: 'Country list mismatch: proof was generated for different countries' },
                { status: 403 },
              );
            }
          }
        }

        // google_workspace / microsoft_365 / workspace: verify domain matches (if requiredDomain is set)
        if (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace') {
          const domain = extractDomain(normalizedInputs, 'oidc_domain_attestation');

          // Only check domain if requiredDomain is set; otherwise any workspace domain is accepted
          if (requiredDomain && domain !== requiredDomain) {
            logger.warn(ROUTE, 'Domain mismatch', { userId: session.userId, topicId, domain, requiredDomain });
            return NextResponse.json(
              { error: `Domain mismatch: expected ${requiredDomain}, got ${domain}` },
              { status: 403 },
            );
          }
        }

        // Save verification to Redis cache (always refresh to ensure domain field exists)
        const cacheType = circuitToCacheType(circuitId);
        const domainForCache = (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace')
          ? extractDomain(normalizedInputs, 'oidc_domain_attestation') ?? undefined
          : undefined;
        await saveVerificationCache(session.userId, cacheType, { domain: domainForCache });
        logger.info(ROUTE, 'Verification cached', { userId: session.userId, cacheType, hasDomain: !!domainForCache });
      } else if (!alreadyVerified) {
        // No proof and no cached verification — return 402 with proof requirement
        logger.info(ROUTE, 'Proof required but not provided, returning 402', { userId: session.userId, topicId, proofType: effectiveProofType });
        const proofRequirement = buildProofRequirement(effectiveProofType, {
          domain: topic.requiredDomain,
          allowedCountries: topic.allowedCountries,
        });
        return NextResponse.json(
          {
            error: 'Proof required to join this topic',
            proofRequirement,
          },
          { status: 402 },
        );
      } else {
        logger.info(ROUTE, 'User has existing valid verification, skipping proof', { userId: session.userId, topicId, proofType: effectiveProofType });
      }
    }

    // Handle join based on visibility
    if (topic.visibility === 'secret') {
      logger.warn(ROUTE, 'Direct join attempt on secret topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'This topic requires an invite code' },
        { status: 403 },
      );
    }

    if (topic.visibility === 'private') {
      // Check for existing join request
      const existingRequest = await db.query.joinRequests.findFirst({
        where: and(eq(joinRequests.topicId, topicId), eq(joinRequests.userId, session.userId)),
      });

      if (existingRequest) {
        if (existingRequest.status === 'pending') {
          logger.warn(ROUTE, 'Duplicate join request', { userId: session.userId, topicId });
          return NextResponse.json(
            { error: 'Join request already pending' },
            { status: 409 },
          );
        }
        if (existingRequest.status === 'rejected') {
          logger.warn(ROUTE, 'Previously rejected join request', { userId: session.userId, topicId });
          return NextResponse.json(
            { error: 'Join request was rejected' },
            { status: 403 },
          );
        }
      }

      // Create pending join request
      await db.insert(joinRequests).values({
        topicId,
        userId: session.userId,
        status: 'pending',
      });

      logger.info(ROUTE, 'Join request submitted for private topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { success: true, status: 'pending', message: 'Join request submitted' },
        { status: 202 },
      );
    }

    // Public topic — instant join
    await db.insert(topicMembers).values({
      topicId,
      userId: session.userId,
      role: 'member',
    });

    logger.info(ROUTE, 'User joined topic successfully', { userId: session.userId, topicId });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
