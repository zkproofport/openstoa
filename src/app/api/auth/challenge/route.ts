import { NextResponse } from 'next/server';
import { createChallenge } from '@/lib/challenge';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/challenge';

export async function POST() {
  logger.info(ROUTE, 'POST request received');
  try {
    const challenge = await createChallenge();
    logger.info(ROUTE, 'Challenge created', { challengeId: challenge.challengeId });
    return NextResponse.json(challenge);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Failed to create challenge', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
