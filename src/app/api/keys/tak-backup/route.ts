/**
 * Phase 4 TAK-keychain backup (design §6.4.1, SI-8). Stores the caller's TAK
 * keychain — every topic's archive root + epoch keys the user holds — as a
 * SINGLE blob encrypted client-side under HKDF(master_key, "openstoa-tak-backup").
 * A recovered master_key re-derives that key and decrypts the blob, so the user
 * re-reads all archived history with no other member online (Option 1). The
 * server stores opaque bytes, never unwraps, and holds no key (no escrow).
 *
 * Scoped to the session user's own row (no user parameter). Not in the public
 * OpenAPI spec — end-user recovery flow, not an AI-agent surface (openstoa Rule 17).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { decodeBase64Strict, checkRateLimit, type RateLimit } from '@/lib/mls/http';
import { upsertTakBackup, getTakBackup, TAK_KEY_BACKUP_MAX_BYTES } from '@/lib/keyBackupStore';

const ROUTE = '/api/keys/tak-backup';
const RATE: RateLimit = { max: 120, windowSec: 60 };

/** GET — return the caller's own encrypted TAK-keychain blob (null if none yet). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const row = await getTakBackup(db, session.userId);
    return NextResponse.json({ ciphertext: row ? row.ciphertext.toString('base64') : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST — upsert the caller's encrypted TAK-keychain blob. Body: { ciphertext:
 * base64 }. The client re-uploads the full snapshot whenever its TAK material
 * changes. Envelope-only validation (base64 + size cap SI-4); never decrypted.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('keys-tak-backup', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const bytes = decodeBase64Strict((body as Record<string, unknown>).ciphertext);
    if (!bytes || bytes.length === 0) {
      return NextResponse.json({ error: 'Valid base64 ciphertext is required' }, { status: 400 });
    }
    if (bytes.length > TAK_KEY_BACKUP_MAX_BYTES) {
      return NextResponse.json({ error: `ciphertext must be ${TAK_KEY_BACKUP_MAX_BYTES} bytes or fewer` }, { status: 400 });
    }

    await upsertTakBackup(db, session.userId, bytes);
    logger.info(ROUTE, 'TAK keychain backup stored', { userId: session.userId, bytes: bytes.length });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
