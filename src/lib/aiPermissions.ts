/** Per-key capability validation. Login authenticates identity; the selected
 * X-OpenStoa-API-Key limits operations for agent and human sessions alike.
 * Routes first enforce the exhaustive policy registry, then resource-level rules.
 */
import { NextResponse } from 'next/server';
import { db as sharedDb } from '@/lib/db';

type DB = typeof sharedDb;

// Ability allowlist spanning the whole app. An API key's `cmd` must be a
// (possibly empty) subset of this set — an unknown or free-form command is
// rejected at validation time (least-privilege, no silent-allow). Empty is
// valid and the most restrictive: the key may do nothing.
export const ALLOWED_CMDS = [
  '/openstoa/topic/read',
  '/openstoa/topic/create',
  '/openstoa/topic/edit',
  '/openstoa/topic/delete',
  '/openstoa/topic/manage-members',
  '/openstoa/post/react',
  '/openstoa/post/record',
  '/openstoa/comment/delete',
  '/openstoa/upload/write',
  '/openstoa/upload/delete',
  '/openstoa/media/read',
  '/openstoa/notification/read',
  '/openstoa/notification/write',
  '/openstoa/chat/manage-keys',

  '/openstoa/topic/join',
  '/openstoa/topic/leave',
  '/openstoa/post/read',
  '/openstoa/post/write',
  '/openstoa/post/delete',
  '/openstoa/comment/read',
  '/openstoa/comment/write',
  '/openstoa/chat/read',
  '/openstoa/chat/send',
  '/openstoa/profile/read',
  '/openstoa/profile/edit',
  '/ai/summarize',
  '/ai/search',
] as const;

export type AllowedCmd = (typeof ALLOWED_CMDS)[number];

// SI-4 caps on the metadata payload. A key carries a handful of command
// paths — cap generously, reject abuse/enumeration.
export const MAX_CMD_COUNT = 32;
export const MAX_CMD_LEN = 128;

/** Additional route-level capability gate. A selected key never inherits its
 * owner's wider permissions. A human session without a selected key keeps the
 * normal account rules; agents without declared scope fail closed.
 */
export async function requireAiCapability(
  db: DB,
  session: { userId: string; isAI?: boolean; apiKeyCmd?: string[]; apiKeyId?: string; deviceKind?: string },
  cmd: AllowedCmd | string,
): Promise<NextResponse | null> {
  void db;
  if (!session.isAI && session.deviceKind !== 'agent' && session.apiKeyId === undefined && session.apiKeyCmd === undefined) return null;
  const ok = (session.apiKeyCmd ?? []).includes(cmd);
  if (ok) return null;
  return NextResponse.json(
    { error: `AI capability required: ${cmd} not permitted` },
    { status: 403 },
  );
}
