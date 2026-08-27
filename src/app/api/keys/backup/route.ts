/**
 * Phase 4 master_key backup (design §6.4, SI-5/SI-8). Crypto-FREE: the server
 * stores only the wrapped ciphertext (recovery-code-wrapped + N passkey-PRF-
 * wrapped copies of the user's master_key) and never holds an unwrap secret, so
 * a DB dump yields nothing decryptable (no escrow). Every operation is scoped to
 * the session user's OWN row — there is no user parameter, so a caller can never
 * read or write another user's backup.
 *
 * NOT in the public OpenAPI spec by design: key recovery is an end-user security
 * flow driven by the web/mobile clients, not an AI-agent API surface. AI agents
 * authenticate via proof each session and do not hold a recoverable master_key
 * (openstoa Rule 17 — internal/non-agent routes are excluded from public docs).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { decodeBase64Strict, checkRateLimit, type RateLimit } from '@/lib/mls/http';
import {
  upsertKeyBackup,
  getKeyBackup,
  upsertPasskeyWrap,
  listPasskeyWraps,
  deletePasskeyWrap,
  countPasskeyWraps,
  KEY_BACKUP_MAX_BYTES,
  MAX_PASSKEYS_PER_USER,
} from '@/lib/keyBackupStore';

const ROUTE = '/api/keys/backup';
const RATE: RateLimit = { max: 60, windowSec: 60 };

/**
 * GET — return the session user's own wrapped master_key material so a device
 * (including a fresh one after total loss) can recover: the recovery-code wrap
 * plus every registered passkey's PRF wrap. Returns ciphertext only; useless
 * without the recovery code or the passkey PRF, so exposing it to the
 * authenticated owner is safe (SI-8).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const recovery = await getKeyBackup(db, session.userId);
    const passkeys = await listPasskeyWraps(db, session.userId);

    /*
     * WHEN, not just whether.
     *
     * "You have a backup" and "you have a backup from four months ago" are
     * different answers to a person about to erase the only device that holds
     * their chat keys — rooms joined since that date are not in it. The
     * sign-in conflict path already returns this (`deviceTakeoverGate`); the
     * clients that ask outside a conflict, like Profile → Device data, had no
     * way to get it and would have had to treat every backup as current or
     * every backup as stale. Both are wrong in the direction that costs
     * history.
     *
     * The NEWEST wrap wins: any single one of them recovers the same
     * master_key, so the account is as protected as its most recent copy.
     * A row with no timestamp (pre-default) contributes nothing rather than
     * contributing zero, which would read as 1970 and mark a good backup
     * stale.
     */
    const stamps = [
      recovery?.updatedAt?.getTime(),
      ...passkeys.map((p) => p.createdAt?.getTime()),
    ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

    return NextResponse.json({
      wrappedMaster: recovery ? recovery.wrappedMaster.toString('base64') : null,
      passkeys: passkeys.map((p) => ({ credentialId: p.credentialId, prfWrapped: p.prfWrapped.toString('base64') })),
      /** Epoch ms of the most recent wrap, or null when there is none. */
      backupUpdatedAt: stamps.length > 0 ? Math.max(...stamps) : null,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * POST — store/update one wrapped copy of the caller's master_key.
 *   { type: 'recovery', wrappedMaster: base64 }              → key_backups (1 per user)
 *   { type: 'passkey', credentialId, prfWrapped: base64 }    → key_backup_passkeys (N per user)
 * The server validates only the envelope (base64, size cap SI-4, passkey count
 * cap); it never inspects or decrypts the ciphertext.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('keys-backup', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { type } = body as Record<string, unknown>;

    if (type === 'recovery') {
      const bytes = decodeBase64Strict((body as Record<string, unknown>).wrappedMaster);
      if (!bytes || bytes.length === 0) {
        return NextResponse.json({ error: 'Valid base64 wrappedMaster is required' }, { status: 400 });
      }
      if (bytes.length > KEY_BACKUP_MAX_BYTES) {
        return NextResponse.json({ error: `wrappedMaster must be ${KEY_BACKUP_MAX_BYTES} bytes or fewer` }, { status: 400 });
      }
      await upsertKeyBackup(db, session.userId, bytes);
      logger.info(ROUTE, 'recovery-code master_key backup stored', { userId: session.userId, bytes: bytes.length });
      return NextResponse.json({ ok: true, type: 'recovery' }, { status: 201 });
    }

    if (type === 'passkey') {
      const { credentialId } = body as Record<string, unknown>;
      if (typeof credentialId !== 'string' || credentialId.trim().length === 0 || credentialId.length > 512) {
        return NextResponse.json({ error: 'credentialId is required' }, { status: 400 });
      }
      const bytes = decodeBase64Strict((body as Record<string, unknown>).prfWrapped);
      if (!bytes || bytes.length === 0) {
        return NextResponse.json({ error: 'Valid base64 prfWrapped is required' }, { status: 400 });
      }
      if (bytes.length > KEY_BACKUP_MAX_BYTES) {
        return NextResponse.json({ error: `prfWrapped must be ${KEY_BACKUP_MAX_BYTES} bytes or fewer` }, { status: 400 });
      }
      // Cap the child table. A new credentialId beyond the cap is rejected; an
      // update to an existing credential is always allowed (count unchanged).
      const existing = await countPasskeyWraps(db, session.userId);
      const wraps = await listPasskeyWraps(db, session.userId);
      const isNew = !wraps.some((w) => w.credentialId === credentialId);
      if (isNew && existing >= MAX_PASSKEYS_PER_USER) {
        return NextResponse.json({ error: `At most ${MAX_PASSKEYS_PER_USER} passkeys per user` }, { status: 400 });
      }
      await upsertPasskeyWrap(db, session.userId, credentialId, bytes);
      logger.info(ROUTE, 'passkey master_key backup stored', { userId: session.userId, credentialId, bytes: bytes.length });
      return NextResponse.json({ ok: true, type: 'passkey' }, { status: 201 });
    }

    return NextResponse.json({ error: "type must be 'recovery' or 'passkey'" }, { status: 400 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}

/**
 * DELETE — revoke one of the caller's passkey wraps by credentialId
 * (?credentialId=...), e.g. when a passkey is removed from the account. The
 * recovery-code wrap is not deletable here (it is the fallback path); rotating it
 * is a POST with a fresh wrappedMaster.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const credentialId = new URL(request.url).searchParams.get('credentialId');
    if (!credentialId || credentialId.trim().length === 0) {
      return NextResponse.json({ error: 'credentialId query parameter is required' }, { status: 400 });
    }
    const removed = await deletePasskeyWrap(db, session.userId, credentialId);
    return NextResponse.json({ removed });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'DELETE', error);
  }
}
