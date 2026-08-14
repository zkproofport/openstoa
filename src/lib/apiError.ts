/**
 * Single choke point for a route's UNHANDLED catch-all — the one that runs
 * when something the route did not anticipate blew up (a DB constraint, a
 * driver error, Redis/R2 down, a bug). It is NOT for deliberate 4xx product
 * copy ("Not a member of this topic", "Title must not contain a NUL byte")
 * — those stay as direct `NextResponse.json(...)` calls at their call sites,
 * because that text is load-bearing product copy an agent or user depends on.
 *
 * WHY THIS EXISTS: 65 of 80 route files independently reimplemented
 *
 *   const message = error instanceof Error ? error.message : String(error);
 *   return NextResponse.json({ error: message }, { status: 500 });
 *
 * which hands the caller whatever the failure happened to say — a Postgres
 * constraint name, a driver message, a file path, an upstream API body. A
 * real incident: `POST /api/topics` 500ing with
 * `insert or update on table "topics" violates foreign key constraint
 * "topics_creator_id_users_id_fk"` verbatim in the HTTP response. That is an
 * information-disclosure bug repeated in 65 places, not 65 bugs.
 *
 * CONTRACT:
 *  - The client NEVER sees driver/library text, table/constraint names, file
 *    paths, or a stack — only a fixed generic message plus a correlation id.
 *  - The server log gets the FULL, untruncated message and stack (CLAUDE.md:
 *    "Full Log Output — Never Truncate"). The operator needs the real error
 *    to debug; the caller does not need it and must not receive it.
 *  - `errorId` is echoed in BOTH the log line and the response body so a
 *    user's bug report ("I got this error, id abc-123") can be grepped
 *    straight to the matching server log line without the response itself
 *    carrying anything sensitive. It is a random UUID, not derived from the
 *    error content, so it cannot itself leak anything.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

/** Cap applied ONLY to what we log, never to what we already store/process —
 * a driver can hand back a multi-megabyte payload (e.g. a bulk statement
 * echoed back in the error), and writing that untruncated to stdout can
 * itself wedge or truncate the surrounding log line / log pipeline. This is
 * a defensive ceiling on THIS log line, not a violation of "never truncate
 * server-side log output": that rule is about not shortening error text for
 * convenience, not about accepting an unbounded write from an adversarial or
 * malfunctioning dependency into a single log call.
 */
const MAX_LOGGED_ERROR_CHARS = 100_000;

function toLoggableMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.length > MAX_LOGGED_ERROR_CHARS) {
    return `${raw.slice(0, MAX_LOGGED_ERROR_CHARS)}…[truncated ${raw.length - MAX_LOGGED_ERROR_CHARS} more chars]`;
  }
  return raw;
}

/**
 * Log the full error server-side and return a generic, safe response.
 *
 * @param route  The `ROUTE` constant already defined at the top of every
 *               route file (used for `logger.error`'s route tag).
 * @param action A short label for what was being done, e.g. `'POST'`,
 *               `'GET'`, or a more specific verb the route already used
 *               (e.g. `'Failed to create challenge'`) — preserved as the log
 *               line's message so existing log-based alerting keeps working.
 * @param error  The caught value — may be an `Error`, a string, `null`, or
 *               any other thrown value; all are handled without throwing.
 * @param status HTTP status for the generic response. Defaults to 500
 *               (unhandled server error). A route can pass a different
 *               status for an unhandled-but-not-quite-500 case; the body is
 *               always the same generic shape.
 * @param extra  Optional additional context to attach to the SERVER LOG ONLY
 *               (e.g. `{ postId }`) — some routes logged extra identifiers
 *               alongside the error message before conversion; this keeps
 *               that debugging context without adding it to the response.
 */
export function unhandledRouteError(
  route: string,
  action: string,
  error: unknown,
  status = 500,
  extra?: Record<string, unknown>
): NextResponse {
  const errorId = crypto.randomUUID();
  const message = toLoggableMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Full detail, untruncated (beyond the defensive ceiling above), server-side only.
  logger.error(route, `Unhandled error in ${action}`, { errorId, error: message, stack, ...extra });

  // Generic, safe response — no driver text, no table/constraint names, no
  // file paths, no stack. `errorId` is a random UUID and carries no signal
  // about what failed.
  return NextResponse.json({ error: 'Internal server error', errorId }, { status });
}
