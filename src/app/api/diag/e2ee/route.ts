/**
 * E2EE key-path diagnostics sink.
 *
 * WHY THIS EXISTS: the client-side key path (device key state → passkey recovery
 * → TAK keychain restore) fails in several distinct ways that all present as one
 * word on screen, and the failures happen on phones whose console nobody can
 * reach. Without this, each hypothesis costs a full rebuild-and-reinstall cycle
 * to test. Reports land next to the API requests that produced them, so a single
 * log read answers "which branch did this device take".
 *
 * WHAT IT MAY CARRY: counts, byte LENGTHS, booleans, store KEY NAMES and error
 * strings. Never key material, ciphertext, or message content — the callers in
 * `webTransport.ts` are the contract, and `diagE2ee.test.ts` holds them to it.
 * Nothing is persisted; the payload is logged and dropped.
 *
 * NOT in the public OpenAPI spec: this is client telemetry for an end-user
 * security flow, not an AI-agent API surface (openstoa Rule 17).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';

const ROUTE = '/api/diag/e2ee';
// Generous enough for a burst during one recovery attempt, low enough that a
// looping client cannot flood the log.
const RATE: RateLimit = { max: 120, windowSec: 60 };
const MAX_STEP_LEN = 64;
const MAX_DETAIL_BYTES = 2048;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('diag-e2ee', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { step, detail } = body as Record<string, unknown>;
    if (typeof step !== 'string' || step.length === 0 || step.length > MAX_STEP_LEN) {
      return NextResponse.json({ error: 'step is required' }, { status: 400 });
    }

    // Truncate rather than reject: a report that is too long is still the only
    // evidence of the branch that produced it.
    let serialized = '';
    try {
      serialized = JSON.stringify(detail ?? {});
    } catch {
      serialized = '"<unserializable>"';
    }
    if (serialized.length > MAX_DETAIL_BYTES) serialized = `${serialized.slice(0, MAX_DETAIL_BYTES)}…[truncated]`;

    logger.info(ROUTE, 'E2EE diagnostic', { userId: session.userId, step, detail: serialized });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
