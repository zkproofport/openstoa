/**
 * Guard for `uuid`-typed path params (`[topicId]`, `[postId]`, `[commentId]`,
 * `[keyId]`) before they reach a Drizzle `eq(<uuid column>, id)` query.
 *
 * WHY THIS EXISTS: every `community_*` table's `id` is a Postgres `uuid`
 * column (`uuid('id').primaryKey().defaultRandom()` in `src/lib/db/schema.ts`).
 * Route handlers destructure the raw path segment and hand it straight to
 * the query with no format check, so a caller who types a non-UUID path
 * segment (`GET /api/posts/not-a-uuid`) makes Postgres itself reject the
 * query with `22P02 invalid input syntax for type uuid`. Before
 * `src/lib/apiError.ts` existed that raw driver message reached the client
 * verbatim in a 500 body (an information-disclosure bug, fixed separately).
 * Fixing the LEAK was not enough on its own: even generic-and-safe, a 500
 * for a malformed id is still the WRONG status. 500 means "the server is
 * broken, an operator should look at this, retry might help" — none of
 * which is true here. The caller sent a bad id; the fix is on their side,
 * not ours, and the correct signal is 400, matched by the same `{ error }`
 * shape the codebase already uses for other bad-input 400s (e.g.
 * `'Invalid JSON body'`, `'Invalid closesAt timestamp'`).
 *
 * SCOPE: this checks SYNTAX only — "could this string possibly name a row"
 * — never EXISTENCE. A well-formed id for a row that doesn't exist is
 * unaffected by this guard and keeps whatever 404 (or other) behavior the
 * route already had; this file must never change that.
 *
 * Deliberately NARROWER than what Postgres's `uuid` column itself accepts.
 * Postgres is lenient — `'12345678123412341234123456789012'::uuid` (no
 * dashes) and `'{...}'::uuid` (braced) both parse, and it does not enforce
 * the RFC 4122 version/variant nibbles. But every id this app ever
 * generates or serializes into a URL comes from Postgres's own
 * `gen_random_uuid()` (via Drizzle's `defaultRandom()`) and is always
 * emitted in canonical lowercase 8-4-4-4-12 hyphenated form — no real
 * caller has any reason to send a no-dash or braced id. Accepting only the
 * canonical shape is strictly safer (rejects exotic-but-technically-valid
 * inputs with a clean 400 instead of letting them reach the driver) with
 * zero cost to any legitimate request.
 */

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: string): boolean {
  return CANONICAL_UUID_RE.test(value);
}
