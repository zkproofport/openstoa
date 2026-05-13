/**
 * Server-side input normalisation for the `?q=` keyword search used by
 * `/api/feed` and `/api/topics`.
 *
 * Three concerns this module owns:
 *
 * 1. **Trim & cap** — the caller can send up to `MAX_QUERY_LENGTH` chars.
 *    Whitespace-only queries become `null` (== "no filter"), matching the
 *    no-fallback rule (an empty filter is *no* filter, never "match
 *    everything containing %%").
 * 2. **Wildcard escape** — `%` and `_` are SQL ilike wildcards; if a user
 *    types either of them we MUST escape so they're matched literally.
 *    Without this, typing `%` matches every row in the table.
 * 3. **Backslash escape** — Postgres ilike's ESCAPE clause needs the
 *    escape character itself to be doubled.
 */

export const MAX_QUERY_LENGTH = 200;

/**
 * Normalise a raw `q` parameter into a value ready for `ilike(col, value)`:
 * - trims surrounding whitespace
 * - returns `null` if empty after trim (signal: skip the filter)
 * - clips to `MAX_QUERY_LENGTH` chars
 * - escapes ilike wildcards so `%` / `_` / `\` match literally
 * - wraps the result in `%...%` for substring matching
 */
export function normaliseSearchQuery(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const clipped = trimmed.slice(0, MAX_QUERY_LENGTH);
  // Order matters: escape backslash first, then the two ilike wildcards.
  const escaped = clipped
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escaped}%`;
}
