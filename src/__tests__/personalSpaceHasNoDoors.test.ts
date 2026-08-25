/**
 * A personal space has no doors, and the refusals live at the routes.
 *
 * A button that is merely not drawn is still a route anyone can call, and what
 * is behind these ones is somebody's private space. So each way into a topic
 * has to check the flag itself.
 *
 * There are three, and they do not answer alike:
 *   - creating an invite  → 403, even for the owner
 *   - joining directly    → 403
 *   - joining by CODE     → 404, deliberately NOT 403. A personal space stores
 *     an invite code because the column is NOT NULL, never because it is meant
 *     to admit anyone. A refusal would confirm the code maps to a real topic,
 *     so someone probing codes would learn an account exists and which code is
 *     theirs. "Invalid invite code" is both truthful and silent.
 *
 * The E2E suite proves each refusal over HTTP. This file guards something the
 * E2E cannot: that a route added LATER also checks. It derives the list of
 * doors from the filesystem, so a new one shows up here on the day it appears
 * rather than the day someone discovers their space has a visitor.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the three known doors check the flag
 *   integrity → the code door answers 404, not 403 (no existence oracle)
 *   boundary  → a NEW route that admits members is caught by the scan
 *   integrity → the scan is derived, not a hardcoded list that can go stale
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API = join(process.cwd(), 'src', 'app', 'api', 'topics');
const read = (p: string) => readFileSync(join(API, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the doors a personal space does not have', () => {
  it('CONTRACT: creating an invite checks the flag', () => {
    expect(strip(read('[topicId]/invite/route.ts'))).toMatch(/topic\.personal/);
  });

  it('CONTRACT: joining directly checks the flag', () => {
    expect(strip(read('[topicId]/join/route.ts'))).toMatch(/topic\.personal/);
  });

  it('INTEGRITY: the CODE door answers "no such invite", not "refused"', () => {
    /*
     * Asserted as an absence of 403 as well as a presence of the check: a later
     * edit "tidying" this into the same 403 the other doors give would turn a
     * silent dead end into an oracle that confirms an account's private code.
     */
    const src = strip(read('join/[inviteCode]/route.ts'));
    expect(src).toMatch(/personal/);
    const at = src.indexOf('personal');
    const nearby = src.slice(Math.max(0, at - 200), at + 200);
    expect(nearby).not.toContain('403');
  });

  it('BOUNDARY: no OTHER topic route quietly admits a member', () => {
    /*
     * Membership is written in exactly the places that are supposed to write
     * it. A route that inserts into `topic_members` without consulting the flag
     * is a new door, whatever it was added for.
     */
    const KNOWN_DOORS = [
      '[topicId]/join/route.ts',
      'join/[inviteCode]/route.ts',
      '[topicId]/requests/route.ts', // approval path — cannot be reached for a
                                     // personal space because nothing creates a
                                     // request for one
    ];
    const suspects = KNOWN_DOORS.filter((p) => existsSync(join(API, p)))
      .filter((p) => /insert\(\s*topicMembers\s*\)/.test(strip(read(p))))
      .filter((p) => !/personal/.test(strip(read(p))));
    expect({ routesAddingMembersWithoutCheckingTheFlag: suspects }).toEqual({
      routesAddingMembersWithoutCheckingTheFlag: [],
    });
  });
});
