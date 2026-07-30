import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/lib/db/schema';
import {
  DEFAULT_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
  badgesForSharedTopics,
  buildDmCandidatesQuery,
  clampCandidateLimit,
} from '@/lib/dmCandidates';
import { normaliseSearchQuery } from '@/lib/search';

/**
 * `GET /api/dm/candidates` — who the caller may start a DM with.
 *
 * The headline correctness requirement is that a person sharing SEVERAL topics
 * with the caller appears exactly ONCE, and that the collapsing happens in SQL
 * rather than by pulling the membership cross-product into JS. A mocked `db`
 * can never prove that, so this file splits the work in three:
 *
 *   1. SQL-shape tests — build the real Drizzle query against a never-connected
 *      pool and assert the emitted SQL carries `GROUP BY peer.user_id`, the
 *      `kind='topic'` restriction, the `peer <> mine` self-exclusion and the
 *      LIMIT. These fail the moment someone "simplifies" the query into a JS
 *      reduce or drops a guard.
 *   2. Pure-helper tests — limit clamping, badge union across shared topics,
 *      and the ilike escaping the route feeds the query.
 *
 * The route's own branches (authz, the isAI gate, response shaping, and the
 * contract that the handler hands the escaped pattern + clamped limit to the
 * builder) live in `dm-candidates-route.test.ts` — a separate file because
 * mocking `@/lib/dmCandidates` there would also stub the very builder this
 * file asserts on. The real-database proof (a peer in three topics coming back
 * as ONE row, DM rooms excluded, UTF-8 nicknames) lives in
 * `src/__tests__/e2e/dm-candidates.test.ts`.
 */

// ── 1. SQL shape ────────────────────────────────────────────────────────────

// Never connects: Pool is lazy and no query is ever executed, only `.toSQL()`.
const offlineDb = drizzle(new Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/none' }), {
  schema,
});

function sqlFor(opts: Parameters<typeof buildDmCandidatesQuery>[2] = {}) {
  return buildDmCandidatesQuery(offlineDb, 'caller-1', opts).toSQL();
}

describe('buildDmCandidatesQuery — de-duplication and exclusions live in SQL', () => {
  it('collapses one row per person with GROUP BY on the peer user id', () => {
    const { sql } = sqlFor();
    expect(sql.toLowerCase()).toContain('group by');
    // Grouping key must be the PEER membership's user id, not the topic.
    expect(sql).toMatch(/group by\s+"peer"\."user_id"/i);
  });

  it('aggregates the shared topics instead of emitting one row per membership', () => {
    const { sql } = sqlFor();
    expect(sql).toContain('json_agg');
    expect(sql).toContain("json_build_object('id'");
    // No JS-side reduce fallback: the topic list is built by the database.
    expect(sql).toMatch(/order by "topics"\."title"\)/i);
  });

  it("excludes kind='dm' rooms from the shared-topic computation", () => {
    const { sql, params } = sqlFor();
    expect(sql).toMatch(/"topics"\."kind" = \$\d/);
    expect(params).toContain('topic');
    expect(params).not.toContain('dm');
  });

  it('excludes the caller themselves via peer.user_id <> mine.user_id', () => {
    const { sql } = sqlFor();
    expect(sql).toMatch(/"peer"\."user_id" <> "mine"\."user_id"/);
  });

  it('filters on the caller membership and applies the limit', () => {
    const { sql, params } = sqlFor({ limit: 42 });
    expect(sql).toMatch(/"mine"\."user_id" = \$\d/);
    expect(params).toContain('caller-1');
    expect(sql.toLowerCase()).toContain('limit');
    expect(params).toContain(42);
  });

  it('adds the nickname ilike filter only when a pattern is supplied', () => {
    expect(sqlFor().sql.toLowerCase()).not.toContain('ilike');
    const withQ = sqlFor({ qPattern: '%kim%' });
    expect(withQ.sql.toLowerCase()).toContain('ilike');
    expect(withQ.params).toContain('%kim%');
  });

  it('orders by nickname so the picker is stable', () => {
    expect(sqlFor().sql).toMatch(/order by "users"\."nickname"/i);
  });
});

// ── 2. Pure helpers ─────────────────────────────────────────────────────────

describe('clampCandidateLimit', () => {
  it('defaults when absent, empty or whitespace', () => {
    expect(clampCandidateLimit(undefined)).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit(null)).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('')).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('   ')).toBe(DEFAULT_CANDIDATE_LIMIT);
  });

  it('defaults on garbage, zero and negatives rather than passing them through', () => {
    expect(clampCandidateLimit('abc')).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('NaN')).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('0')).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('-5')).toBe(DEFAULT_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('Infinity')).toBe(DEFAULT_CANDIDATE_LIMIT);
  });

  it('accepts 1 and caps at the maximum', () => {
    expect(clampCandidateLimit('1')).toBe(1);
    expect(clampCandidateLimit('37')).toBe(37);
    expect(clampCandidateLimit(String(MAX_CANDIDATE_LIMIT))).toBe(MAX_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('1000000')).toBe(MAX_CANDIDATE_LIMIT);
    expect(clampCandidateLimit('12.9')).toBe(12);
  });
});

describe('badgesForSharedTopics — union of what each shared topic would show', () => {
  const kyc = { type: 'kyc', label: 'KYC' };
  const country = { type: 'country', label: 'Country' };
  const workspace = { type: 'workspace', label: 'acme.com', domain: 'acme.com' };
  const all = [kyc, country, workspace];

  it('shows nothing when the only shared topic is open', () => {
    expect(badgesForSharedTopics(all, ['none'])).toEqual([]);
  });

  it('shows only the badge each shared topic gates on', () => {
    expect(badgesForSharedTopics(all, ['kyc'])).toEqual([kyc]);
    expect(badgesForSharedTopics(all, ['country'])).toEqual([country]);
    expect(badgesForSharedTopics(all, ['google_workspace'])).toEqual([workspace]);
  });

  it('unions across several shared topics without duplicating', () => {
    const out = badgesForSharedTopics(all, ['kyc', 'country', 'kyc', 'none']);
    expect(out).toEqual([kyc, country]);
  });

  it('tolerates null / unknown proof types and an empty badge set', () => {
    expect(badgesForSharedTopics(all, [null])).toEqual([]);
    expect(badgesForSharedTopics(all, ['made_up'])).toEqual([]);
    expect(badgesForSharedTopics([], ['kyc'])).toEqual([]);
    expect(badgesForSharedTopics(all, [])).toEqual([]);
  });
});

describe('nickname search normalisation feeding the ilike filter', () => {
  it('treats blank and whitespace-only q as "no filter", never %%', () => {
    expect(normaliseSearchQuery('')).toBeNull();
    expect(normaliseSearchQuery('   ')).toBeNull();
  });

  it('escapes ilike wildcards and the escape char itself', () => {
    expect(normaliseSearchQuery('%')).toBe('%\\%%');
    expect(normaliseSearchQuery('_')).toBe('%\\_%');
    expect(normaliseSearchQuery('a\\b')).toBe('%a\\\\b%');
    expect(normaliseSearchQuery('100%_x')).toBe('%100\\%\\_x%');
  });

  it('passes UTF-8 nicknames through unharmed', () => {
    expect(normaliseSearchQuery('김철수')).toBe('%김철수%');
    expect(normaliseSearchQuery('🦊 fox')).toBe('%🦊 fox%');
  });

  it('clips a very long query to the 200-char cap', () => {
    const pattern = normaliseSearchQuery('x'.repeat(5000))!;
    expect(pattern.length).toBe(202); // 200 chars + the two % wrappers
  });
});
