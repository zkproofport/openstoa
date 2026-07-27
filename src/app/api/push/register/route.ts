/**
 * Phase 6 push notifications — device token registration (design §13, D13
 * near-blind gateway). The server maps an opaque, client-generated
 * `routingHandle` → OS `pushToken` and never puts message content in a push
 * (SI-1 for push). Every operation is scoped to the session user's OWN token —
 * there is no user parameter, so a caller can never register or delete another
 * user's token.
 *
 * NOT in the public OpenAPI spec by design: push registration is an app-only
 * end-user flow driven by the mobile/web clients, NOT an AI-agent API surface
 * (openstoa Rule 17 — internal/non-agent routes are excluded from public docs).
 * AI agents authenticate per session and receive no device push.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';
import {
  upsertToken,
  deleteToken,
  isValidPlatform,
  PUSH_HANDLE_MAX_BYTES,
  PUSH_TOKEN_MAX_BYTES,
} from '@/lib/pushStore';

const ROUTE = '/api/push/register';
const RATE: RateLimit = { max: 60, windowSec: 60 };

/**
 * POST — register or rotate one push token for the caller's routing handle.
 * Body: { routingHandle, pushToken, platform } where platform ∈ {ios, android}.
 * Re-registering the same handle is a plain upsert (token rotation, not a dup).
 * Validates only the envelope (non-empty strings, size caps SI-4, platform
 * allowlist); the server never inspects message content (there is none here).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('push-register', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { routingHandle, pushToken, platform } = body as Record<string, unknown>;

    if (typeof routingHandle !== 'string' || routingHandle.trim().length === 0) {
      return NextResponse.json({ error: 'routingHandle is required' }, { status: 400 });
    }
    if (routingHandle.length > PUSH_HANDLE_MAX_BYTES) {
      return NextResponse.json({ error: `routingHandle must be ${PUSH_HANDLE_MAX_BYTES} bytes or fewer` }, { status: 400 });
    }
    if (typeof pushToken !== 'string' || pushToken.trim().length === 0) {
      return NextResponse.json({ error: 'pushToken is required' }, { status: 400 });
    }
    if (pushToken.length > PUSH_TOKEN_MAX_BYTES) {
      return NextResponse.json({ error: `pushToken must be ${PUSH_TOKEN_MAX_BYTES} bytes or fewer` }, { status: 400 });
    }
    if (!isValidPlatform(platform)) {
      return NextResponse.json({ error: "platform must be 'ios' or 'android'" }, { status: 400 });
    }

    const id = await upsertToken(db, session.userId, routingHandle, pushToken, platform);
    // Log token length only — never the token value (SI: no content/secret in logs).
    logger.info(ROUTE, 'push token registered', {
      userId: session.userId,
      routingHandle,
      platform,
      tokenBytes: pushToken.length,
      id,
    });
    return NextResponse.json({ ok: true, platform }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE — unregister/expire the caller's token for a routing handle
 * (?routingHandle=...). Scoped to the session user, so a caller can only remove
 * its own token. Unknown handles are a no-op (removed: 0).
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const routingHandle = new URL(request.url).searchParams.get('routingHandle');
    if (!routingHandle || routingHandle.trim().length === 0) {
      return NextResponse.json({ error: 'routingHandle query parameter is required' }, { status: 400 });
    }
    const removed = await deleteToken(db, session.userId, routingHandle);
    return NextResponse.json({ removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
