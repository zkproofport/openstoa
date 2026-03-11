import { NextRequest, NextResponse } from 'next/server';
import { createRelayProofRequest } from '@/lib/relay';
import { COMMUNITY_SCOPE } from '@/lib/proof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/proof-request';

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    let circuitType = 'coinbase_attestation';
    let scope = COMMUNITY_SCOPE;

    try {
      const body = await request.json();
      if (body.circuitType) circuitType = body.circuitType;
      if (body.scope) scope = body.scope;
    } catch {
      // No body or invalid JSON — use defaults (login flow sends no body)
    }

    logger.info(ROUTE, 'Creating relay proof request', { circuitType, scope });

    const { requestId, deepLink } = await createRelayProofRequest(scope, { circuitType });

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
