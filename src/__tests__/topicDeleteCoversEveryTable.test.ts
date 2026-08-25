/**
 * Deleting a topic must clear every table that points at it.
 *
 * THE DEFECT, found on staging. Deleting a room that had ever been chatted in
 * returned 500. Five tables reference `topics` with `ON DELETE NO ACTION` and
 * the handler did not touch any of them — `mls_groups`, `mls_commits`,
 * `tak_bundles`, `chat_archive`, `archive_holders` — so the final
 * `delete(topics)` hit a foreign-key violation, the transaction rolled back and
 * the caller got an unhandled error. Confirmed against the staging database: a
 * room holding 13 commits, 13 bundles and 2 archived rows refused to go, and
 * the constraint named in the error was one of these.
 *
 * All five arrived with E2EE, after the delete handler was written. Nothing
 * connected the two, which is exactly the shape this test exists to close: a
 * SIXTH such table added tomorrow fails here rather than in production.
 *
 * WHY A SOURCE-LEVEL TEST. The alternative — spin a database, create a topic,
 * chat in it, delete it — is an E2E test and there is one. This one answers a
 * different question: does the handler know about every table that EXISTS,
 * including tables no E2E case happens to populate? That is a property of the
 * schema and the handler read together, and reading them is how it is checked.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → every non-cascading `topic_id` table is deleted by the handler
 *   integrity  → cascading tables are NOT deleted (a redundant delete is a
 *                second place to forget, and hides a schema change)
 *   integrity  → the parent row goes LAST
 *   boundary   → the lists are derived from source, never hand-copied
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'src/lib/db/schema.ts'), 'utf8');
const HANDLER = readFileSync(
  join(ROOT, 'src/app/api/topics/[topicId]/route.ts'),
  'utf8',
);

/** The `delete(...)` calls inside the DELETE handler's transaction, in order. */
function deletedTables(): string[] {
  const start = HANDLER.indexOf('export async function DELETE');
  expect(start).toBeGreaterThan(-1);
  const body = HANDLER.slice(start);
  const end = body.indexOf('\n}\n');
  const scope = end === -1 ? body : body.slice(0, end);
  return [...scope.matchAll(/tx\.delete\((\w+)\)/g)].map((m) => m[1]);
}

/**
 * Every drizzle table with a `topic_id` column, split by whether the foreign
 * key cascades.
 *
 * Derived from the schema source rather than listed here: a hand-written list
 * would have to be updated by the same person who forgot the handler, which is
 * no check at all.
 */
function topicTables(): { cascading: string[]; manual: string[] } {
  const cascading: string[] = [];
  const manual: string[] = [];
  // `export const name = pgTable('sql_name', { ...fields... })`
  for (const m of SCHEMA.matchAll(/export const (\w+) = pgTable\(\s*'([\w]+)'/g)) {
    const [, varName] = m;
    const bodyStart = m.index! + m[0].length;
    // The table's own object literal ends at the next top-level `export const`.
    const nextExport = SCHEMA.indexOf('\nexport const ', bodyStart);
    const body = SCHEMA.slice(bodyStart, nextExport === -1 ? undefined : nextExport);
    if (!/topicId:\s*\w+\('topic_id'/.test(body)) continue;
    // The FK is declared inline: `.references(() => topics.id, { onDelete: 'cascade' })`
    const fk = body.match(/topicId:[\s\S]*?\n/)?.[0] ?? '';
    (/{\s*onDelete:\s*'cascade'\s*}/.test(fk) ? cascading : manual).push(varName);
  }
  return { cascading, manual };
}

describe('deleting a topic clears every table that points at it', () => {
  const { cascading, manual } = topicTables();

  it('BOUNDARY: the schema really does have tables of both kinds', () => {
    // If this ever reads zero the parser has drifted and every assertion below
    // is vacuously true — the worst possible failure mode for this file.
    expect(manual.length).toBeGreaterThan(3);
    expect(cascading.length).toBeGreaterThan(0);
  });

  it('CONTRACT: every non-cascading topic table is deleted by the handler', () => {
    const deleted = new Set(deletedTables());
    // `topics` itself is the parent, not a child.
    const missing = manual.filter((t) => t !== 'topics' && !deleted.has(t));
    expect(missing).toEqual([]);
  });

  it('INTEGRITY: cascading tables are NOT deleted by hand', () => {
    // A redundant delete is a second place to forget, and it hides the fact
    // that the schema is already handling it — so the next person cannot tell
    // which mechanism is load-bearing.
    const deleted = new Set(deletedTables());
    const redundant = cascading.filter((t) => deleted.has(t));
    expect(redundant).toEqual([]);
  });

  it('INTEGRITY: the parent row goes last', () => {
    const order = deletedTables();
    expect(order[order.length - 1]).toBe('topics');
  });

  it('INTEGRITY: mls_commits is cleared before mls_groups', () => {
    // A commit belongs to the group it advanced. Not a foreign key today, but
    // the order states the relationship for anyone reading it.
    const order = deletedTables();
    const commits = order.indexOf('mlsCommits');
    const groups = order.indexOf('mlsGroups');
    expect(commits).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(commits);
  });

  it('REGRESSION: the five tables the 500 came from are all covered', () => {
    // Named explicitly as well as derived, so the specific defect stays legible
    // to someone reading the failure rather than the whole file.
    const deleted = new Set(deletedTables());
    for (const table of ['mlsGroups', 'mlsCommits', 'takBundles', 'chatArchive', 'archiveHolders']) {
      expect(deleted.has(table), `${table} is not deleted with its topic`).toBe(true);
    }
  });
});
