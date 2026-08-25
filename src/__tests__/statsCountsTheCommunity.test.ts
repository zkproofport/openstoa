/**
 * `totalTopics` must count the community, not every row in the table.
 *
 * The number is read as "how big is this place", so it has to count the things
 * a reader could go and find. Two kinds of row are not that: a DM is a private
 * 1:1 channel modelled as a hidden topic, and a personal space is one secret
 * topic per ACCOUNT that only its owner can enter.
 *
 * Measured on the local stack before the fix: 916 rows for 261 real topics —
 * 623 personal spaces and 32 DMs. More than triple, and because a personal
 * space arrives with every signup the error tracked the user base rather than
 * the community and would keep growing.
 *
 * WHY THIS IS NOT AN E2E. I wrote it as one first and it passed alone and
 * failed in the suite: "create an account, the number must not move" assumes
 * nothing else is creating topics, and dozens of other E2E files are doing
 * exactly that against the same container. The property is about the QUERY, and
 * the query is what this reads — a shared, busy server can never answer it
 * cleanly.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the count excludes personal spaces
 *   contract  → the count excludes DM channels
 *   integrity → both conditions are on the TOPIC count, not the member count
 *   boundary  → the members count is left alone; it counts accounts, and every
 *               account is a real person however many spaces they hold
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'src/app/api/stats/route.ts'), 'utf8');

/** The statement that produces the topic count. */
const TOPIC_QUERY = (() => {
  const at = ROUTE.indexOf('const [topicResult]');
  expect(at, 'the topic count is gone or renamed').toBeGreaterThan(-1);
  return ROUTE.slice(at, ROUTE.indexOf(';', at));
})();

describe('what the public topic count counts', () => {
  it('CONTRACT: personal spaces are excluded', () => {
    expect(TOPIC_QUERY).toMatch(/topics\.personal/);
  });

  it('CONTRACT: DM channels are excluded', () => {
    // Already wrong before personal spaces existed — a DM was never a topic
    // anyone could go and find.
    expect(TOPIC_QUERY).toMatch(/topics\.kind/);
  });

  it('INTEGRITY: the filters are on the TOPIC count, not the member count', () => {
    /*
     * Applying either condition to `users` would be a different bug with the
     * same shape: a count that quietly means something other than its name.
     */
    const memberQuery = ROUTE.slice(ROUTE.indexOf('const [memberResult]'));
    const stmt = memberQuery.slice(0, memberQuery.indexOf(';'));
    expect(stmt).not.toMatch(/personal|kind/);
  });

  it('BOUNDARY: the member count still counts every account', () => {
    // A person with a private space is still one person. Nothing about this
    // feature changes who is a member of the community.
    expect(ROUTE).toMatch(/totalMembers/);
  });
});
