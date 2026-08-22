import { Client, QueryResultRow } from 'pg';

/**
 * Direct PostgreSQL access for E2E tests that need to verify the actual
 * DB row state (not just the HTTP response). Used by activity-bump and
 * search tests to close the "API said X but did the row really change?"
 * gap.
 *
 * Connection is gated on `E2E_STAGING_DB_URL` — when unset, the helpers
 * report `hasDb() === false`. Test cases use `it.skipIf(envGate('E2E_STAGING_DB_URL'))`
 * (not bare `it.skipIf(!hasDb())` — see `envGate` below for why) to opt out
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

/**
 * A skipped case and a passing case look identical in vitest's summary line —
 * that is precisely how `.env.test.local` went missing on this machine for
 * seven weeks without anyone noticing (activity-bump.test.ts, feed.test.ts,
 * and, gated on `DATABASE_URL` rather than this file, chat-delivery-purge.test.ts
 * and topic-crud.test.ts were all silently skipping DB-backed cases the whole
 * time). `envGate` + `announceEnvGates` close that gap: use
 * `it.skipIf(envGate('SOME_VAR'))` in place of a bare `it.skipIf(!cond)`, and
 * call `announceEnvGates(<this file's name>)` once, after every `it()` in the
 * file has registered, to print exactly how many cases that var disabled.
 *
 * Counting happens at COLLECTION time: `describe(name, fn)` runs `fn`
 * synchronously to register its `it()`s, and `it.skipIf(cond)` evaluates
 * `cond` eagerly as part of that same call — so by the time execution reaches
 * a statement placed after the closing `describe(...)` (or after the last
 * `it.skipIf(envGate(...))` call), every gate in the file has already been
 * counted. Vitest gives each test file its own module graph by default
 * (`isolate: true`), so this file's copy of the counter starts fresh per test
 * file and never mixes counts across files.
 */
const envGateCounts = new Map<string, number>();

/** Same boolean as `!process.env[varName]`, but tallies the miss for `announceEnvGates`. */
export function envGate(varName: string): boolean {
  const missing = !process.env[varName];
  if (missing) envGateCounts.set(varName, (envGateCounts.get(varName) ?? 0) + 1);
  return missing;
}

/**
 * Print one line per env var this file gated on and skipped at least one case
 * for. Call after every `it.skipIf(envGate(...))` in the file has run (i.e.
 * once, near the bottom of the file) — never inside a test body, or it would
 * fire once per case instead of once per run.
 */
export function announceEnvGates(fileLabel: string): void {
  for (const [varName, count] of envGateCounts) {
    // eslint-disable-next-line no-console -- deliberate: this is the one
    // thing in the file meant to be loud in the run's own stdout, not routed
    // through the app logger (which a reader skimming test output won't be
    // watching).
    console.warn(
      `\n[E2E] ${varName} is unset — ${count} DB-backed case${count === 1 ? '' : 's'} in ${fileLabel} ` +
        `will be reported as SKIPPED, not run. Set ${varName} in .env.test.local to enable ` +
        `${count === 1 ? 'it' : 'them'} (see .env.test.local.example).\n`,
    );
  }
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
 * EXPLAIN with `enable_seqscan` forced off for this one statement, then
 * restored. Proves an index is real, correctly typed, and actually reachable
 * by the planner — independent of whether the CURRENT table size makes the
 * planner prefer it unforced, which on a dev container it correctly does not
 * (see the search-performance guards in feed.test.ts). Session-scoped (this
 * file's `getClient()` caches one connection), so the reset in `finally`
 * matters: leaving `enable_seqscan=off` set would silently change every
 * later query on the same connection.
 */
export async function explainIndexOnly(sql: string, params: unknown[] = []): Promise<string> {
  const c = await getClient();
  await c.query('SET enable_seqscan = off');
  try {
    const res = await c.query<{ ['QUERY PLAN']: string }>(`EXPLAIN ${sql}`, params);
    return res.rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await c.query('SET enable_seqscan = on');
  }
}
