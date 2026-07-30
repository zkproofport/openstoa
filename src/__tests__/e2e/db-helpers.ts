import { Client, QueryResultRow } from 'pg';

/**
 * Direct PostgreSQL access for E2E tests that need to verify the actual
 * DB row state (not just the HTTP response). Used by activity-bump and
 * search tests to close the "API said X but did the row really change?"
 * gap.
 *
 * Connection is gated on `E2E_STAGING_DB_URL` — when unset, the helpers
 * report `hasDb() === false` and test cases use `it.skipIf` to opt out
 * cleanly. This keeps the default CI run working without leaking a DB
 * URL into the repo while still allowing full verification when a Cloud
 * SQL Proxy is running locally.
 *
 * Run locally with:
 *
 *   ./scripts/db-proxy.sh staging proxy   # terminal 1
 *   export E2E_STAGING_DB_URL="postgresql://USER:PASS@localhost:15432/openstoa"
 *   npx vitest run -c vitest.config.e2e.ts <test>
 */

const DB_URL = process.env.E2E_STAGING_DB_URL;
const BASE_URL = process.env.E2E_BASE_URL ?? '(E2E_BASE_URL unset)';

/**
 * Callers only ever look up ids they created over HTTP against `E2E_BASE_URL`
 * seconds earlier, so a missing row does not mean "no row" — it means this
 * connection is pointed at a different database than the one under test.
 * Saying so beats letting the caller dereference `null`.
 */
function assertSameDatabase<T>(row: T | null, what: string, id: string): T {
  if (row) return row;
  throw new Error(
    `DB/HTTP mismatch: ${what} ${id} was created over HTTP at ${BASE_URL} but is not visible through ` +
      `E2E_STAGING_DB_URL. Point E2E_STAGING_DB_URL at the database ${BASE_URL} actually writes to ` +
      `(./scripts/db-proxy.sh <env> proxy), or unset it to skip the direct-DB assertions.`,
  );
}

let cached: Client | null = null;

export function hasDb(): boolean {
  return Boolean(DB_URL);
}

async function getClient(): Promise<Client> {
  if (!DB_URL) throw new Error('E2E_STAGING_DB_URL not set — direct DB checks disabled');
  if (cached) return cached;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  cached = client;
  return cached;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.end();
    cached = null;
  }
}

async function selectOne<T extends QueryResultRow>(text: string, values: unknown[]): Promise<T | null> {
  const c = await getClient();
  const res = await c.query<T>(text, values);
  return res.rows[0] ?? null;
}

export interface PostRow {
  id: string;
  score: string | number;
  last_activity_at: Date | string | null;
  upvote_count: number;
  comment_count: number;
  topic_id: string;
}

export interface TopicRow {
  id: string;
  score: string | number;
  last_activity_at: Date | string | null;
}

export async function getPostRow(postId: string): Promise<PostRow> {
  const row = await selectOne<PostRow>(
    `SELECT id, score, last_activity_at, upvote_count, comment_count, topic_id
     FROM posts WHERE id = $1`,
    [postId],
  );
  return assertSameDatabase(row, 'post', postId);
}

export async function getTopicRow(topicId: string): Promise<TopicRow> {
  const row = await selectOne<TopicRow>(
    `SELECT id, score, last_activity_at
     FROM topics WHERE id = $1`,
    [topicId],
  );
  return assertSameDatabase(row, 'topic', topicId);
}

/**
 * Verify a pg_trgm GIN index actually exists. Used by the search
 * performance guard test to confirm migration 0010 ran.
 */
export async function indexExists(name: string): Promise<boolean> {
  const c = await getClient();
  const res = await c.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [name],
  );
  return res.rows[0]?.exists ?? false;
}

/**
 * Returns the query plan as a single text blob for the given SQL. Used
 * to assert that ilike on title/content actually picks the trigram
 * index, not a sequential scan.
 */
export async function explain(sql: string, params: unknown[] = []): Promise<string> {
  const c = await getClient();
  const res = await c.query<{ ['QUERY PLAN']: string }>(`EXPLAIN ${sql}`, params);
  return res.rows.map((r) => r['QUERY PLAN']).join('\n');
}
