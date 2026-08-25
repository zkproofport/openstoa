/**
 * Every route that writes against a post asks whether the caller may.
 *
 * This was a five-part defect discovered one part at a time. `comments`
 * checked membership; `reactions`, `vote`, `bookmark` and `record` checked
 * nothing, and after those four were fixed a sweep of the directory turned up
 * a fifth — `poll/vote` — which still let a stranger move the tally on a poll
 * inside somebody's private topic. Observed as a 200.
 *
 * Four rounds of "and one more" is the signal that memory is the wrong tool.
 * So the list is derived from the filesystem: a sixth route added tomorrow
 * fails this test on the day it appears, rather than on the day someone
 * notices a number they did not put there.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → every post-write route consults an authorisation rule
 *   integrity → the scan finds the routes itself; no hand-kept list
 *   boundary  → a scan that matches nothing fails rather than passing quietly
 *   contract  → the shared rule still exists and is what they consult
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POSTS = join(process.cwd(), 'src', 'app', 'api', 'posts');

function routes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) routes(full, out);
    else if (e === 'route.ts') out.push(full);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Ways a route can legitimately answer "may this caller write here?".
 *
 * `canActOnPost` is the shared rule. The others are the narrower checks that
 * predate it and are correct for what they guard: the post's own edit/delete
 * path compares the author, and `pin` requires an owner or admin.
 */
const AUTHORISED = /canActOnPost|topicMembers|Not a member|authorId === session|isAdmin|isOwner/;

describe('post-write routes and authorisation', () => {
  const writers = routes(POSTS)
    .map((f) => ({ file: f.slice(POSTS.length + 1), src: strip(readFileSync(f, 'utf8')) }))
    .filter(({ src }) => /export async function (POST|PATCH|PUT|DELETE)/.test(src));

  it('BOUNDARY: the scan found the write routes', () => {
    // A scan that matches nothing passes the assertion below while checking
    // none of it — the way this kind of test rots when a directory moves.
    expect(writers.length).toBeGreaterThanOrEqual(5);
  });

  it('CONTRACT: each of them consults an authorisation rule', () => {
    const unguarded = writers.filter(({ src }) => !AUTHORISED.test(src)).map(({ file }) => file);
    expect({ postWriteRoutesWithoutAnAuthorisationCheck: unguarded }).toEqual({
      postWriteRoutesWithoutAnAuthorisationCheck: [],
    });
  });

  it('CONTRACT: the shared rule exists and says what it should', () => {
    /*
     * Pinned here as well as at the call sites: the routes could all keep
     * calling a `canActOnPost` that had been quietly loosened to return true.
     */
    const rule = readFileSync(join(process.cwd(), 'src/lib/postReadable.ts'), 'utf8');
    expect(rule).toMatch(/visibility === 'public' \|\| .*visibility === 'private'/);
    expect(rule).toMatch(/topicMembers/);
  });
});
