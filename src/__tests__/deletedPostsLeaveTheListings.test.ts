/**
 * A deleted post is not a listing entry.
 *
 * FOUND BY THE VERIFICATION AGENT, cleaning up after itself on staging. It
 * deleted a post, got `200 {"isDeleted":true}` — and then, instead of stopping
 * there, re-read the public feed. The row was still in it:
 *
 *   {"id":"7bb3feb8-…","title":"","content":"",
 *    "authorNickname":"dev_user_85816120","topicTitle":"p2recheck-B-…"}
 *
 * Deletion is SOFT on purpose: the row survives so on-chain records and
 * comments keep resolving. But it clears the title, the content and the media,
 * so a listing draws an empty card with the author's name still on it. Somebody
 * deletes their post and everyone keeps seeing that they posted, minus what
 * they said — close to the opposite of what they asked for.
 *
 * The response carries no `isDeleted` either, so a client cannot even label it
 * "[deleted]". It has nothing to go on and renders a blank.
 *
 * The tombstone still answers on the post's own route, which is what records
 * and comments actually follow.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the feed excludes deleted posts
 *   contract  → the topic listing excludes them too
 *   integrity → BOTH, because one listing hiding them and the other not is the
 *               drift that makes a rule feel random
 *   boundary  → the post's OWN route is untouched: the tombstone must still
 *               resolve or comments and on-chain records break
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The clause builder each listing uses to decide which rows it returns. */
function whereBuilder(file: string, marker: string): string {
  const src = read(file);
  const at = src.indexOf(marker);
  expect(at, `${file}: the where-clause builder moved`).toBeGreaterThan(-1);
  return src.slice(at, at + 1200);
}

describe('what the listings do with a deleted post', () => {
  it('CONTRACT: the feed excludes them', () => {
    const clause = whereBuilder('src/app/api/feed/route.ts', 'function buildWhereConditions');
    expect(clause).toMatch(/posts\.isDeleted/);
  });

  it('CONTRACT: the topic listing excludes them', () => {
    const clause = whereBuilder(
      'src/app/api/topics/[topicId]/posts/route.ts',
      'const base = ',
    );
    expect(clause).toMatch(/posts\.isDeleted/);
  });

  it('INTEGRITY: both, so the rule cannot be half-applied', () => {
    /*
     * Two listings answering the same question differently is how a rule stops
     * looking like a rule: a post vanishes from one screen and lingers on
     * another, and nobody can say which is right.
     */
    const feed = read('src/app/api/feed/route.ts');
    const topic = read('src/app/api/topics/[topicId]/posts/route.ts');
    expect([feed, topic].every((s) => /eq\(posts\.isDeleted, false\)/.test(s))).toBe(true);
  });

  it('BOUNDARY: the post route still serves the tombstone', () => {
    /*
     * The row is kept ON PURPOSE — comments and on-chain records point at it.
     * A fix that hid it everywhere would break the thing soft deletion exists
     * for, and it would do so quietly.
     */
    const post = read('src/app/api/posts/[postId]/route.ts');
    expect(post).not.toMatch(/where:\s*and\([^)]*isDeleted[^)]*false/);
  });
});
