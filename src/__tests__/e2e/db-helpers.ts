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

export function getPostRow(postId: string): Promise<PostRow | null> {
  return selectOne<PostRow>(
    `SELECT id, score, last_activity_at, upvote_count, comment_count, topic_id
     FROM posts WHERE id = $1`,
    [postId],
  );
}

export function getTopicRow(topicId: string): Promise<TopicRow | null> {
  return selectOne<TopicRow>(
    `SELECT id, score, last_activity_at
     FROM topics WHERE id = $1`,
    [topicId],
  );
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
