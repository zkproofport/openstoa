/**
 * Push notification preferences — the GLOBAL switch (P-M) plus a read-only view
 * of every per-topic mute (P-S, written via `PATCH /api/topics/{topicId}/push`).
 *
 * Every operation is scoped to the session user's OWN preferences — there is no
 * user parameter, so a caller can never read or change another user's settings.
 * The server stores a preference only; it holds no message content here and the
 * OS-level notification permission still lives on the device (clients reconcile
 * the two and offer to open system settings when the OS has blocked pushes).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { checkRateLimit, type RateLimit } from '@/lib/mls/http';
import {
  getPushPreferences,
  setGlobalPushEnabled,
  listMutedTopicIds,
} from '@/lib/pushPrefs';

const ROUTE = '/api/push/preferences';
const RATE: RateLimit = { max: 60, windowSec: 60 };

/**
 * @openapi
 * /api/push/preferences:
 *   get:
 *     tags: [Push]
 *     summary: Read your push notification preferences
 *     description: |
 *       Returns the caller's own notification preferences: the global on/off switch and the list of
 *       topics muted individually. **A brand-new account has never written a preference, and the
 *       defaults are permissive** — `enabled` comes back `true` and `mutedTopicIds` comes back empty
 *       without any row existing, so you never have to "initialise" preferences before reading them.
 *
 *       Precedence, when deciding whether a device will actually be notified for a topic:
 *       `enabled === false` wins over everything — a globally-off user is notified for NO topic, even
 *       one absent from `mutedTopicIds`. Only when `enabled === true` does per-topic mute matter.
 *
 *       These preferences gate DEVICE push (mobile/web push registered via `POST /api/push/register`).
 *       An AI-agent session has no device and receives no push, so an agent normally reads this only
 *       to display or mirror a human user's settings.
 *     operationId: getPushPreferences
 *     x-related-skills: [update-push-preferences, get-topic-push-preference, update-topic-push-preference]
 *     responses:
 *       200:
 *         description: The caller's current preferences
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Global switch. `true` (the default) means this account may receive push notifications; `false` means every push is suppressed regardless of per-topic settings.
 *                 mutedTopicIds:
 *                   type: array
 *                   items: { type: string, format: uuid }
 *                   description: Topic ids the caller muted individually, oldest mute first. Empty when nothing is muted. A topic in this list is silent even while `enabled` is `true`.
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { description: Rate limit exceeded — max 60 preference calls per minute per user }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('push-prefs', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const prefs = await getPushPreferences(db, session.userId);
    return NextResponse.json(prefs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/push/preferences:
 *   patch:
 *     tags: [Push]
 *     summary: Turn push notifications on or off globally
 *     description: |
 *       Sets the caller's GLOBAL notification switch. This is the in-app equivalent of the OS-level
 *       notification toggle and is deliberately independent of it: turning this off suppresses every
 *       push server-side even while the operating system still permits them, and turning it on does
 *       NOT grant OS permission (a client whose OS permission is denied must send the user to system
 *       settings — it cannot be fixed from here).
 *
 *       `enabled: false` beats every per-topic setting: no topic notifies, muted or not. Un-muting a
 *       topic while globally off therefore changes nothing visible until this is set back to `true`;
 *       per-topic mutes are preserved across the round trip rather than reset.
 *
 *       Idempotent — sending the same value twice is a no-op that returns the same body, so a
 *       double-tap or two racing clients converge instead of erroring.
 *     operationId: updatePushPreferences
 *     x-related-skills: [get-push-preferences, update-topic-push-preference]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: 'Send `true` to allow push notifications for this account, `false` to suppress all of them. Must be a real JSON boolean — the strings "true"/"false", 0/1, and null are rejected with 400 so an ambiguous value can never be read as "off".'
 *     responses:
 *       200:
 *         description: Updated preferences — the same shape `GET` returns, read back from the database
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: The stored global switch after the update (echoed from the database, not from the request).
 *                 mutedTopicIds:
 *                   type: array
 *                   items: { type: string, format: uuid }
 *                   description: Per-topic mutes, unchanged by this call — returned so a client can refresh its whole preference view in one round trip.
 *       400: { description: '`enabled` missing or not a boolean, or the body is not valid JSON' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { description: Rate limit exceeded — max 60 preference calls per minute per user }
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    if (!(await checkRateLimit('push-prefs', session.userId, RATE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { enabled } = body as Record<string, unknown>;
    // Strict boolean only: "false"/0/null must NOT be coerced — a mis-typed
    // value silently read as "off" would be an unrequested opt-out.
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const stored = await setGlobalPushEnabled(db, session.userId, enabled);
    const mutedTopicIds = await listMutedTopicIds(db, session.userId);
    logger.info(ROUTE, 'global push preference updated', {
      userId: session.userId,
      enabled: stored,
      mutedTopics: mutedTopicIds.length,
    });
    return NextResponse.json({ enabled: stored, mutedTopicIds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
