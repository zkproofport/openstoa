import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  getAiPermissions,
  setAiPermissions,
  AiPermissionValidationError,
  ALLOWED_CMDS,
} from '@/lib/aiPermissions';

const ROUTE = '/api/profile/ai-permissions';

/**
 * @openapi
 * /api/profile/ai-permissions:
 *   get:
 *     tags: [Profile]
 *     summary: Get your AI capability configuration
 *     description: |
 *       Returns the AI-permission set the current user has configured for their OWN account
 *       (design §7). In OpenStoa an AI is not a separate account — it is an `isAI` session acting
 *       on this user's account. This endpoint reports what such sessions are allowed to do across
 *       the whole app: `cmd` is the ability allowlist (a subset of `allowedCmd`), `historyGrant`
 *       is the chat archive scope the AI may back-fill. If the user has never configured
 *       permissions, `cmd` is `[]` (the AI may do nothing) and `historyGrant` is `none`.
 *
 *       An isAI session calling a gated route (topic join/leave, post write/delete, comment write,
 *       chat send/read, profile edit) without the matching `cmd` gets 403. Humans are unaffected.
 *     operationId: getAiPermissions
 *     x-related-skills: [set-ai-permissions, create-api-key]
 *     responses:
 *       200:
 *         description: The caller's AI capability configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cmd:
 *                   type: array
 *                   items: { type: string }
 *                   description: Ability allowlist currently granted to the caller's AI sessions.
 *                 historyGrant:
 *                   type: string
 *                   description: 'Chat archive scope the AI may back-fill: none | Nd | since_epoch:N | full.'
 *                 allowedCmd:
 *                   type: array
 *                   items: { type: string }
 *                   description: The full set of capabilities a user may grant (for building the UI).
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const perm = await getAiPermissions(db, session.userId);
    return NextResponse.json({
      cmd: perm?.cmd ?? [],
      historyGrant: perm?.historyGrant ?? 'none',
      allowedCmd: ALLOWED_CMDS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/profile/ai-permissions:
 *   put:
 *     tags: [Profile]
 *     summary: Set your AI capability configuration
 *     description: |
 *       Replaces the AI-permission set for the caller's OWN account (design §7). A user can only
 *       configure their own permissions — the record is keyed by the session user. `cmd` must be a
 *       (possibly empty) subset of the allowed commands; an empty array means the caller's AI
 *       sessions may do nothing. `historyGrant` must be a valid archive scope. Stores NO keys and
 *       NO plaintext (SI-1) — pure access-control metadata.
 *     operationId: setAiPermissions
 *     x-related-skills: [get-ai-permissions, create-api-key]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cmd, historyGrant]
 *             properties:
 *               cmd:
 *                 type: array
 *                 items: { type: string }
 *                 description: 'Ability allowlist — a (possibly empty) subset of the allowed commands, e.g. ["/openstoa/chat/send", "/openstoa/post/write"]. Unknown commands are rejected with 400.'
 *               historyGrant:
 *                 type: string
 *                 description: 'Chat archive scope the AI may back-fill: none | Nd | since_epoch:N | full. Invalid scope → 400.'
 *     responses:
 *       200:
 *         description: Updated AI capability configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cmd: { type: array, items: { type: string } }
 *                 historyGrant: { type: string }
 *       400: { description: Invalid cmd (unknown/too many) or historyGrant scope }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { cmd, historyGrant } = body as Record<string, unknown>;

    let row;
    try {
      row = await setAiPermissions(db, session.userId, { cmd, historyGrant });
    } catch (e) {
      if (e instanceof AiPermissionValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    logger.info(ROUTE, 'AI permissions updated', {
      userId: session.userId,
      cmd: row.cmd,
      historyGrant: row.historyGrant,
    });
    return NextResponse.json({ cmd: row.cmd, historyGrant: row.historyGrant });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PUT', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
