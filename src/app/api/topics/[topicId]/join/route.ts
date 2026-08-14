import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
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
import { broadcastMembershipSystemEvent } from '@/lib/chat';
import { requireAiCapability } from '@/lib/aiPermissions';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';

const ROUTE = '/api/topics/[topicId]/join';

/**
 * @openapi
 * /api/topics/{topicId}/join:
 *   post:
 *     tags: [Topics]
 *     summary: Join or request to join topic
 *     description: |
 *       Joins a topic. Response depends on `visibility` and `proofType`:
 *         - `public`: joins immediately (201).
 *         - `private`: **not joinable here (403)** — invite only. Use
 *           `POST /api/topics/join/{inviteCode}`. The approval flow this route used to offer
 *           (202 + a pending request) has been removed: a private topic's invite link is also
 *           what carries its chat-history keys, so an approved member would arrive without them.
 *         - `secret`: not joinable here (403) — same invite route.
 *
 *       Join requests created before that change are still listed and approvable by an
 *       owner/admin at `GET`/`PATCH /api/topics/{topicId}/requests`; no new ones are created.
 *
 *       Some topics gate membership on a ZK proof. The required circuit depends on the topic's
 *       `proofType` field:
 *         - `none` (or unset / `requiresCountryProof=false`) — no proof required.
 *         - `country` (legacy: `requiresCountryProof=true`) — circuit
 *           `coinbase_country_attestation`. Proves the caller's residence country is in the
 *           topic's allowed list.
 *         - `kyc` — circuit `coinbase_attestation`. Proves Coinbase KYC completion.
 *         - `workspace` / `google_workspace` / `microsoft_365` — circuit
 *           `oidc_domain_attestation`. Proves the caller's verified Google or Microsoft account
 *           belongs to the topic's allowed domain.
 *
 *       Generate the proof with `proofport-cli` against the matching circuit, then send
 *       `{ proof, publicInputs }` in the body. A `402` response with `requiredProofType` is
 *       returned when the proof is missing or invalid. Verifications are cached per
 *       `(userId, circuit, scope)` for 24 hours so repeat joins skip the proof step. The Bearer
 *       token used here comes from the agent login flow.
 *     operationId: joinTopic
 *     x-related-skills: [topic-proofs, auth-details]
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
 *             description: >-
 *               Required only when the topic has a non-`none` `proofType` (or legacy
 *               `requiresCountryProof=true`). The body is otherwise an empty `{}`.
 *             properties:
 *               proof:
 *                 type: string
 *                 description: >-
 *                   0x-prefixed hex string of the UltraHonk proof emitted by
 *                   `proofport-cli prove <circuit>` where `<circuit>` matches the topic's
 *                   `proofType`: `coinbase_country_attestation` for country, `coinbase_attestation`
 *                   for kyc, `oidc_domain_attestation` for workspace.
 *               publicInputs:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: >-
 *                   Public inputs of the proof as an array of 0x-prefixed hex strings (one
 *                   element per field). The shape varies per circuit — see the circuit's
 *                   public-input layout in `proofport-cli`.
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
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       402:
 *         description: >-
 *           Proof required to join this topic. Response includes full proof generation guide with
 *           CLI commands, challenge endpoint, and step-by-step
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
 *                     Complete proof generation guide. Includes challenge endpoint (POST /api/auth/challenge),
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
 *         description: >-
 *           Invite-only topic (`private` or `secret` — join via
 *           `POST /api/topics/join/{inviteCode}`), or the caller's country is not in the
 *           topic's allowed list.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       409:
 *         description: Already a member of this topic
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
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

    // Profile-level AI capability (design §7): an isAI caller must hold the
    // topic/join capability in its owner's profile. Humans unaffected.
    const joinGate = await requireAiCapability(db, session, '/openstoa/topic/join');
    if (joinGate) {
      logger.warn(ROUTE, 'AI caller lacks topic/join capability', { userId: session.userId, topicId });
      return joinGate;
    }

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
      const { proof, publicInputs } = body as { proof?: string; publicInputs?: string | string[] };

      // Validate proof data format
      if (proof !== undefined) {
        if (typeof proof !== 'string' || proof.trim() === '') {
          return NextResponse.json({ error: 'Invalid proof: must be a non-empty string' }, { status: 400 });
        }
      }
      if (publicInputs !== undefined) {
        const isEmptyString = typeof publicInputs === 'string' && publicInputs.trim() === '';
        const isEmptyArray = Array.isArray(publicInputs) && publicInputs.length === 0;
        if (isEmptyString || isEmptyArray) {
          return NextResponse.json({ error: 'Invalid publicInputs: must be non-empty' }, { status: 400 });
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

    /*
     * Only a PUBLIC topic can be joined through this route. `private` and
     * `secret` are both invite-only: the invite link is the credential, and for
     * `private` it is also what carries the chat history keys in its fragment
     * (design §"The decision") — an approval flow admits a member the inviter
     * never handed keys to, which is why it is gone rather than merely unused.
     *
     * ALLOWLIST, not a blocklist: anything that is not exactly 'public' needs an
     * invite. A row carrying an unexpected visibility (a bad write, a future
     * tier added without touching this branch) must fail CLOSED rather than
     * fall through to the instant-join path below.
     */
    if (topic.visibility !== 'public') {
      logger.warn(ROUTE, 'Direct join attempt on invite-only topic', {
        userId: session.userId,
        topicId,
        visibility: topic.visibility,
      });
      return NextResponse.json(
        { error: 'This topic requires an invite code' },
        { status: 403 },
      );
    }

    // Public topic — instant join
    await db.insert(topicMembers).values({
      topicId,
      userId: session.userId,
      role: 'member',
    });

    // Real membership transition → persist + publish one `joined the
    // chat` system message. `await` so Next.js doesn't cut the
    // background promise after returning the response (Cloud Run will
    // cleanup the instance otherwise). The helper swallows its own
    // errors so a Redis hiccup never rolls back the join.
    await broadcastMembershipSystemEvent(topicId, session.userId, 'join');

    logger.info(ROUTE, 'User joined topic successfully', { userId: session.userId, topicId });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
