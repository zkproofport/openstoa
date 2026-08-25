import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';
import { deviceFromRequest } from '@/lib/deviceFromRequest';
import { checkDeviceTakeover } from '@/lib/deviceTakeoverGate';
import { unhandledRouteError } from '@/lib/apiError';
import { ensurePersonalTopic } from '@/lib/personalTopic';

const ROUTE = '/api/auth/dev-login';
/**
 * Length cap on a requested name.
 *
 * Deliberately looser than the 20-character `NICKNAME_REGEX` the real profile
 * endpoint enforces: suites here name accounts after what they are testing, and
 * tightening that would break callers for no benefit. The cap exists only so an
 * unbounded string cannot be written to a `text` column.
 */
const NICKNAME_MAX = 64;

/**
 * Dev-only auth endpoint for E2E testing.
 * Creates a test user with a random ID and returns a Bearer token.
 * ONLY available when APP_ENV !== 'production'.
 */
export async function POST(request: NextRequest) {
  if (process.env.APP_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 404 });
  }

  logger.info(ROUTE, 'Dev login request');

  try {
    const body = await request.json().catch(() => ({}));
    const requested = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if (requested.length > NICKNAME_MAX) {
      return NextResponse.json({ error: 'nickname is too long' }, { status: 400 });
    }
    const nickname = requested || `dev_user_${randomBytes(4).toString('hex')}`;
    // Dev-only: mint an `isAI` session so E2E tests can exercise the profile-
    // level AI capability gate over real HTTP (mirrors an agent CLI session).
    const isAI = body.isAI === true;

    /*
     * A NAMED login comes back as the same person.
     *
     * This used to look for an existing row by `id` — a value minted fresh on
     * every request, so the lookup never matched and the insert always ran.
     * `users.nickname` is unique, so the second call with any given name died
     * on a constraint violation and answered 500: an endpoint that exists for
     * repeatable testing worked exactly once per name. Reusing the account is
     * also what a caller means by naming it — two devices signing in as the
     * same person is the scenario scoped-tier chat is tested with.
     *
     * An UNNAMED login stays a fresh account, which is what E2E suites want
     * when they need an identity of their own.
     */
    const existing = requested
      ? await db.query.users.findFirst({ where: eq(users.nickname, nickname) })
      : null;
    let userId = existing?.id ?? `0x${randomBytes(32).toString('hex')}`;

    if (!existing) {
      try {
        await db.insert(users).values({ id: userId, nickname });
        // Same space every real account gets — see `ensurePersonalTopic`.
        await ensurePersonalTopic(userId);
      } catch (error) {
        // Two calls for the same new name can race between the read and the
        // write. The loser re-reads rather than failing: both callers asked
        // for the same person and both should get them.
        const raced = await db.query.users.findFirst({ where: eq(users.nickname, nickname) });
        if (!raced) throw error;
        userId = raced.id;
      }
    }

    const device = deviceFromRequest(request);
    const deviceKind = isAI ? 'agent' : device.kind;

    /*
     * THE SAME ONE-PHONE RULE AS THE REAL LOGIN.
     *
     * This is a dev endpoint, but it is a HUMAN login path — the emulator and
     * the E2E suite reach an account through it. Leaving the rule out would
     * mean the behaviour under test is not the behaviour that ships, and the
     * first place anyone would notice is production.
     *
     * `takeover` comes from the body rather than a query string because this
     * endpoint is a POST; the shape is otherwise identical to the poll route's.
     */
    const decision = await checkDeviceTakeover({
      userId,
      deviceKind,
      deviceId: device.id,
      takeover: body.takeover === true,
    });
    if (decision.kind === 'conflict') {
      return NextResponse.json(decision.body, { status: 409 });
    }

    const token = await createSession(userId, nickname, {
      isAI,
      // An AI is an agent no matter what header it sent.
      deviceKind,
      deviceId: device.id,
    });

    logger.info(ROUTE, existing ? 'Dev user reused' : 'Dev user created', {
      userId,
      nickname,
      isAI,
    });

    return NextResponse.json({ userId, nickname, token, isAI });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'Error', error);
  }
}
