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
import { unhandledRouteError } from '@/lib/apiError';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';

const ROUTE = '/api/diag/e2ee';
// Generous enough for a burst during one recovery attempt, low enough that a
// looping client cannot flood the log.
const RATE: RateLimit = { max: 120, windowSec: 60 };
const MAX_STEP_LEN = 64;
const MAX_DETAIL_BYTES = 2048;
// One request may carry a burst of lines. The client batches them because one
// request per line spent ten of the sixty-nine a single room open cost against
// a hundred-a-minute edge limit — narration was taking down the link preview
// and the chat subscription with it.
const MAX_LINES = 100;

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
    /*
     * Two shapes, on purpose. `{ lines: [...] }` is what the phone sends now;
     * the single `{ step, detail }` stays because the web client still sends it
     * and because a batch of one should not need a different call.
     */
    const { step, detail, lines, dropped } = body as Record<string, unknown>;
    const batch = Array.isArray(lines)
      ? lines
      : typeof step === 'string'
        ? [{ step, detail }]
        : null;
    if (!batch || batch.length === 0) {
      return NextResponse.json({ error: 'step or lines is required' }, { status: 400 });
    }
    if (batch.length > MAX_LINES) {
      return NextResponse.json({ error: `at most ${MAX_LINES} lines` }, { status: 400 });
    }

    // Every line is checked BEFORE anything is written, so a bad one cannot
    // leave half a batch in the log. Strict rather than skip-and-carry-on: the
    // client writes these lines itself, so a malformed one is a bug here, and
    // the single-line shape has always answered 400 for exactly these values.
    for (const raw of batch) {
      const s = (raw ?? {} as Record<string, unknown>).step as unknown;
      if (typeof s !== 'string' || s.length === 0 || s.length > MAX_STEP_LEN) {
        return NextResponse.json({ error: 'step is required' }, { status: 400 });
      }
    }

    for (const raw of batch) {
      const line = raw as Record<string, unknown>;
      const s = line.step as string;
      // Truncate rather than reject: a report that is too long is still the
      // only evidence of the branch that produced it.
      let serialized = '';
      try {
        serialized = JSON.stringify(line.detail ?? {});
      } catch {
        serialized = '"<unserializable>"';
      }
      if (serialized.length > MAX_DETAIL_BYTES) {
        serialized = `${serialized.slice(0, MAX_DETAIL_BYTES)}…[truncated]`;
      }
      logger.info(ROUTE, 'E2EE diagnostic', {
        userId: session.userId,
        step: s,
        detail: serialized,
      });
    }
    // Say how many the client had to throw away, so a shortened log never reads
    // as a complete one.
    if (typeof dropped === 'number' && dropped > 0) {
      logger.info(ROUTE, 'E2EE diagnostic', {
        userId: session.userId,
        step: 'diag/dropped',
        detail: JSON.stringify({ count: dropped }),
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
