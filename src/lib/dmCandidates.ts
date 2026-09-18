/**
 * DM candidate resolution (P-D follow-up).
 *
 * A DM may only be started with someone the caller **shares at least one topic
 * with**. That restriction is deliberate: identities here are anonymous
 * nullifiers, and shared-topic membership is the only thing standing between
 * DM and an open spam/harassment channel. This module owns the one query that
 * answers "who may I DM?" for public identity display.
 *
 * Three invariants the query itself must carry (NOT a JS post-pass):
 *
 * 1. **One row per person.** A peer sharing five topics with the caller must
 *    appear exactly once, with all five topics collapsed into `sharedTopics`.
 *    The collapsing is `GROUP BY peer.user_id` in SQL — reducing in JS would
 *    mean fetching the full membership cross-product first, which is exactly
 *    what blows up for a user sitting in several large topics.
 * 2. **DM rooms are not topics.** `topics.kind='dm'` rows are hidden 2-member
 *    channels; if they counted as "a topic we share", every past DM
 *    counterpart would leak back in as if they were a topic peer. The join
 *    matches `kind='topic'` positively (same shape `/api/topics` uses) so no
 *    future `kind` value can silently qualify either.
 * 3. **A person you already DM is not a "new conversation" candidate.** This
 *    list backs the picker's whole point — discovering someone NOT already
 *    in the Direct tab — so a peer with an existing `kind='dm'` channel is
 *    excluded via a `NOT EXISTS` anti-join on `topics.dm_pair` (the same
 *    canonical, order-independent pair identity `POST /api/dm` uses, see
 *    `canonicalDmPair` in `dm.ts`). This is a SEPARATE concern from
 *    `isDmCandidate()` (`dmCandidatesCache.ts`), which answers "may I message
 *    this person AT ALL" (yes, for an existing DM partner too — `POST /api/dm`
 *    never re-checks shared-topic membership once a channel exists) rather
 *    than "should they appear in the NEW-conversation list" — conflating the
 *    two by simply filtering this query's result in JS would silently hide
 *    the DM button for someone you already talk to.
 */

import { and, eq, ilike, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './db/schema';
import { topicMembers, topics, users } from './db/schema';
import { type Badge } from './verification-cache';

/** Default page size for the candidate list. */
export const DEFAULT_CANDIDATE_LIMIT = 200;
/** Hard ceiling — a caller in dozens of large topics must not pull unbounded rows. */
export const MAX_CANDIDATE_LIMIT = 500;

/** A topic the caller and the candidate are both members of. */
export interface SharedTopic {
  id: string;
  title: string;
}

/** One row as it comes back from the database (pre badge attachment). */
export interface DmCandidateRow {
  userId: string;
  nickname: string;
  profileImage: string | null;
  sharedTopics: SharedTopic[];
  /** Legacy query metadata; never controls public badge visibility. */
  proofTypes: (string | null)[];
}

/** One entry of `GET /api/dm/candidates`. */
export interface DmCandidate {
  userId: string;
  nickname: string;
  profileImage: string | null;
  badges: Badge[];
  sharedTopics: SharedTopic[];
}

/**
 * Clamp a caller-supplied `limit` into `1..MAX_CANDIDATE_LIMIT`.
 * Garbage (`abc`, `NaN`, `0`, `-5`, `1e9`) falls back to the default rather
 * than reaching the query as an unbounded or negative row count.
 */
export function clampCandidateLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_CANDIDATE_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CANDIDATE_LIMIT;
  const int = Math.floor(n);
  if (int < 1) return DEFAULT_CANDIDATE_LIMIT;
  return Math.min(int, MAX_CANDIDATE_LIMIT);
}

/**
 * The "who may I DM?" query.
 *
 * ```sql
 * SELECT peer.user_id, u.nickname, u.profile_image,
 *        json_agg(json_build_object('id', t.id, 'title', t.title) ORDER BY t.title),
 *        array_agg(DISTINCT t.proof_type)
 *   FROM community_topic_members mine
 *   JOIN community_topics        t    ON t.id = mine.topic_id AND t.kind = 'topic'
 *   JOIN community_topic_members peer ON peer.topic_id = mine.topic_id
 *                                    AND peer.user_id <> mine.user_id
 *   JOIN community_users         u    ON u.id = peer.user_id
 *  WHERE mine.user_id = $1
 *    AND NOT EXISTS (
 *          SELECT 1 FROM community_topics existing_dm
 *           WHERE existing_dm.kind = 'dm'
 *             AND existing_dm.dm_pair IN (peer.user_id || '|' || $1, $1 || '|' || peer.user_id)
 *        )
 *    [AND u.nickname ILIKE $2]
 *  GROUP BY peer.user_id, u.nickname, u.profile_image
 *  ORDER BY u.nickname
 *  LIMIT $3
 * ```
 *
 * `GROUP BY peer.user_id` is the de-duplication (matrix row 2), `peer.user_id
 * <> mine.user_id` is the self-exclusion (row 3), and the `NOT EXISTS` is the
 * existing-DM exclusion (row 4, new-conversation-picker only) — all three
 * live in the database, so none can be lost by a later refactor of the
 * handler. The `IN (a || '|' || b, b || '|' || a)` form checks both possible
 * orderings of `dm_pair` directly rather than replicating `canonicalDmPair`'s
 * `sort()` as a SQL comparison — simpler, and does not depend on Postgres's
 * default collation agreeing with JS string sort for these values.
 *
 * Returned as a builder (not awaited) so tests can assert the emitted SQL via
 * `.toSQL()` without a live connection.
 */
export function buildDmCandidatesQuery(
  db: NodePgDatabase<typeof schema>,
  userId: string,
  opts: { qPattern?: string | null; limit?: number } = {},
) {
  const mine = alias(topicMembers, 'mine');
  const peer = alias(topicMembers, 'peer');
  const existingDm = alias(topics, 'existing_dm');

  const filters: SQL[] = [
    eq(mine.userId, userId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(existingDm)
        .where(
          and(
            eq(existingDm.kind, 'dm'),
            sql`${existingDm.dmPair} in (${peer.userId} || '|' || ${userId}, ${userId} || '|' || ${peer.userId})`,
          ),
        ),
    ),
  ];
  if (opts.qPattern) filters.push(ilike(users.nickname, opts.qPattern));

  return db
    .select({
      userId: peer.userId,
      nickname: users.nickname,
      profileImage: users.profileImage,
      sharedTopics: sql<
        SharedTopic[]
      >`json_agg(json_build_object('id', ${topics.id}, 'title', ${topics.title}) ORDER BY ${topics.title})`.as(
        'shared_topics',
      ),
      proofTypes: sql<(string | null)[]>`array_agg(DISTINCT ${topics.proofType})`.as('proof_types'),
    })
    .from(mine)
    // kind='topic' matched positively: DM rooms (and any future kind) never
    // count as a shared topic.
    .innerJoin(topics, and(eq(topics.id, mine.topicId), eq(topics.kind, 'topic')))
    .innerJoin(peer, and(eq(peer.topicId, mine.topicId), ne(peer.userId, mine.userId)))
    .innerJoin(users, eq(users.id, peer.userId))
    .where(and(...filters))
    .groupBy(peer.userId, users.nickname, users.profileImage)
    .orderBy(users.nickname)
    .limit(opts.limit ?? DEFAULT_CANDIDATE_LIMIT);
}
