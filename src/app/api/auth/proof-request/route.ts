import { NextRequest, NextResponse } from 'next/server';
import type { CircuitType } from '@zkproofport-app/sdk';
import { createRelayProofRequest } from '@/lib/relay';
import { COMMUNITY_SCOPE } from '@/lib/proof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/proof-request';

/**
 * @openapi
 * /api/auth/proof-request:
 *   post:
 *     tags: [Auth]
 *     summary: Create relay proof request for mobile flow
 *     description: >-
 *       Initiates mobile ZK proof authentication. Creates a relay request and returns a deep link
 *       that opens the ZKProofport mobile app for proof generation. The client should then poll
 *       /api/auth/poll/{requestId} for the result.
 *     operationId: createProofRequest
 *     security: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               circuitType:
 *                 type: string
 *                 enum: [coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation]
 *                 description: ZK circuit type to request proof for
 *               scope:
 *                 type: string
 *                 description: Custom scope string for the proof request
 *               countryList:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: ISO 3166-1 alpha-2 country codes for country attestation
 *               isIncluded:
 *                 type: boolean
 *                 description: Whether countryList is an inclusion list (true) or exclusion list (false)
 *     responses:
 *       200:
 *         description: Proof request created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requestId:
 *                   type: string
 *                   description: Unique relay request identifier for polling
 *                 deepLink:
 *                   type: string
 *                   example: "zkproofport://proof-request?..."
 *                   description: Deep link URL to open the ZKProofport mobile app
 *                 scope:
 *                   type: string
 *                   description: Scope string embedded in the proof request
 *                 circuitType:
 *                   type: string
 *                   description: Circuit type requested
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    let circuitType: CircuitType = 'coinbase_attestation';
    let scope = COMMUNITY_SCOPE;
    let countryList: string[] | undefined;
    let isIncluded: boolean | undefined;
    let domain: string | undefined;

    try {
      const body = await request.json();
      if (body.circuitType) circuitType = body.circuitType;
      if (body.scope) scope = body.scope;
      if (Array.isArray(body.countryList)) countryList = body.countryList;
      if (typeof body.isIncluded === 'boolean') isIncluded = body.isIncluded;
      if (typeof body.domain === 'string') domain = body.domain;
    } catch {
      // No body or invalid JSON — use defaults (login flow sends no body)
    }

    logger.info(ROUTE, 'Creating relay proof request', { circuitType, scope, countryList, isIncluded, domain });

    const { requestId, deepLink } = await createRelayProofRequest(scope, { circuitType, countryList, isIncluded, domain });

    logger.info(ROUTE, 'Relay proof request created', { requestId, circuitType, scope });
    return NextResponse.json({
      requestId,
      deepLink,
      scope,
      circuitType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Failed to create relay proof request', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
