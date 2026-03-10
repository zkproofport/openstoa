import { NextResponse } from 'next/server';
import { createRelayProofRequest } from '@/lib/relay';
import { COMMUNITY_SCOPE } from '@/lib/proof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/proof-request';

export async function POST() {
  logger.info(ROUTE, 'POST request received');
  try {
    const { requestId, deepLink } = await createRelayProofRequest(COMMUNITY_SCOPE);

    logger.info(ROUTE, 'Relay proof request created', { requestId, scope: COMMUNITY_SCOPE });
    return NextResponse.json({
      requestId,
      deepLink,
      scope: COMMUNITY_SCOPE,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Failed to create relay proof request', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
