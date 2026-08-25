/**
 * The menu must not offer what the server refuses.
 *
 * This screen already states the principle in its own comments — "an action
 * that always fails is worse than an absent one" — and applies it twice: the
 * owner gets no Leave, and a non-admin gets no Invite on a scoped topic. A
 * personal space is one more case of the same thing, and it was missed.
 *
 * WHAT THAT COSTS. Invite is the bad one. Tapping it opens the share dialog,
 * and the request comes back 403 — but by then the owner has been told, by the
 * app, that their private space is shareable. The refusal arrives second and
 * reads as a fault rather than as the rule it is. `Requests` is milder: nothing
 * can ever create a join request for a space nobody can ask to join, so the
 * screen behind it is permanently empty.
 *
 * Read from source because the failure is an ABSENCE — a missing condition in a
 * list builder — and nothing else in either repo would notice it coming back.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → Invite is gated on the flag
 *   contract  → Requests is gated on the flag
 *   integrity → the flag is part of the memo's dependencies, or the menu keeps
 *               the previous topic's answer after navigating between topics
 *   boundary  → ordinary topics still get both actions
 *   contract  → Leave stays absent for an owner, which already covers this case
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCREEN = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'screens/topics/TopicDetailScreen.tsx'),
  'utf8',
);

/** The condition guarding a pushed menu item, read back from the source. */
function guardBefore(label: string): string {
  const at = SCREEN.indexOf(`t('openstoa.topicDetail.${label}')`);
  expect(at, `no ${label} action in the menu`).toBeGreaterThan(-1);
  const from = SCREEN.lastIndexOf('if (', at);
  return SCREEN.slice(from, at);
}

describe('what a personal space does NOT offer', () => {
  it('CONTRACT: Invite is gated on the flag', () => {
    expect(guardBefore('invite')).toContain('personal');
  });

  it('CONTRACT: Requests is gated on the flag', () => {
    expect(guardBefore('requests')).toContain('personal');
  });

  it('INTEGRITY: the flag is a dependency of the memoised menu', () => {
    /*
     * Without it the list is not rebuilt when the topic changes, so opening a
     * personal space after an ordinary one shows the ordinary one's menu — the
     * exact actions this file exists to remove, on the exact screen where they
     * do harm.
     */
    const deps = SCREEN.slice(SCREEN.indexOf('confirmLeave, topic?.visibility'));
    expect(deps.slice(0, 120)).toContain('topic?.personal');
  });

  it('BOUNDARY: an ordinary topic still gets both actions', () => {
    // The point is one more condition, not the removal of the actions.
    expect(SCREEN).toContain("t('openstoa.topicDetail.invite')");
    expect(SCREEN).toContain("t('openstoa.topicDetail.requests')");
  });

  it('CONTRACT: Leave is still absent for an owner', () => {
    // Which already covers a personal space, since its owner is its only
    // member — the case that was right before any of this was added.
    const at = SCREEN.indexOf("t('openstoa.topicDetail.leave')", SCREEN.indexOf('const items'));
    expect(SCREEN.slice(SCREEN.lastIndexOf('if (', at), at)).toContain('!isOwner');
  });
});

describe('the space still reaches the Topics tab', () => {
  /*
   * THE REGRESSION THIS EXISTS FOR. The server was changed to send the space
   * BESIDE the browse list — `pinned` — so that a filtered or searched list
   * keeps its promise that every row in it matched. The mini-app kept reading
   * `res.topics` only, so under the "All" tab the space stopped appearing at
   * all: the fix on one side became a disappearance on the other, and the one
   * topic a person is meant to always find was the one that went missing.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → the screen reads `pinned` and puts it first
   *   integrity → a row for it already in `topics` is not duplicated
   *   boundary  → no pinned space (guest, or not made yet) is not a crash
   */
  const HOME = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'screens/topics/TopicsHomeScreen.tsx'),
    'utf8',
  );

  it('CONTRACT: the browse query reads `pinned`', () => {
    expect(HOME).toMatch(/res\.pinned/);
  });

  it('CONTRACT: it goes in FRONT of the rows', () => {
    // Behind them it is below thirty topics, which is the same as absent on a
    // screen people scan rather than read.
    expect(HOME).toMatch(/\[\s*res\.pinned\s*,\s*\.\.\.\s*rows/);
  });

  it('INTEGRITY: it is not shown twice if the list already carries it', () => {
    expect(HOME).toMatch(/filter\(\(t\)\s*=>\s*t\.id\s*!==\s*res\.pinned/);
  });

  it('BOUNDARY: no pinned space just returns the rows', () => {
    expect(HOME).toMatch(/if\s*\(!res\.pinned\)\s*return rows;/);
  });
});
