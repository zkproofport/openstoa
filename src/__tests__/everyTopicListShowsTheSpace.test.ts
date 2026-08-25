/**
 * Whoever asks for the topic LIST has to show the space that comes with it.
 *
 * The server sends it beside the list — `pinned` — rather than inside, so a
 * searched or category-filtered `topics` array keeps its promise that every row
 * in it matched. That is correct on the server and useless on its own: a client
 * that reads `topics` only shows no space at all, which is how the fix on one
 * side became a disappearance on the other. It happened exactly that way in the
 * mini-app, and was caught on a phone rather than by any test.
 *
 * So the obligation is checked where it lives: at every call site that asks for
 * the browse list. The list of call sites is derived from the source, so a
 * fourth screen added tomorrow fails this the day it appears rather than the
 * day someone notices their space is missing from it.
 *
 * NOT every caller — a widget that shows "6 active topics" is a sample, not a
 * list, and prepending a personal space to it would be noise. Those are named
 * with the reason, which is a decision that should be re-read rather than
 * inherited silently.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → every list-bearing caller reads `pinned`
 *   integrity → the scan finds the callers itself, no hardcoded list
 *   boundary  → a scan that matches nothing fails rather than passing silently
 *   contract  → the server still sends the field the clients are reading
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__' || e === '.next') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Callers that ask for a SAMPLE rather than the list, with the reason.
 * A personal space at the top of a six-item "active now" widget is noise.
 */
const SAMPLES = ['src/components/RightSidebar.tsx', 'src/components/LeftSidebar.tsx'];

describe('every browse-list caller shows the pinned space', () => {
  const callers = walk(join(ROOT, 'src'))
    .map((f) => ({ file: f.slice(ROOT.length + 1), src: strip(readFileSync(f, 'utf8')) }))
    .filter(({ file, src }) => /api\/topics\?view=all/.test(src) && !file.startsWith('src/app/api/'))
    // Documentation pages print a curl example; they render nothing.
    .filter(({ src }) => !/curl -s/.test(src));

  it('BOUNDARY: the scan actually found callers', () => {
    // A scan that matches nothing passes everything below while checking none
    // of it — the way this kind of test rots when files move.
    expect(callers.length).toBeGreaterThan(0);
  });

  it('CONTRACT: each list-bearing caller reads `pinned`', () => {
    const missing = callers
      .filter(({ file }) => !SAMPLES.includes(file))
      .filter(({ src }) => !/\bpinned\b/.test(src))
      .map(({ file }) => file);
    expect({ listsThatWouldNotShowTheSpace: missing }).toEqual({
      listsThatWouldNotShowTheSpace: [],
    });
  });

  it('CONTRACT: the server still sends what those clients read', () => {
    // Both halves in one file, so removing either is a failing test rather
    // than a silent disappearance.
    const route = readFileSync(join(ROOT, 'src/app/api/topics/route.ts'), 'utf8');
    expect(route).toMatch(/pinned:/);
  });
});

describe('the space changes when there is something to lose', () => {
  /*
   * Before the personal space, a brand-new account held nothing: no membership,
   * no chat keys, nothing recovery could protect. The prompt could reasonably
   * wait, and the module said so — "once the user has joined a topic".
   *
   * That sentence is now false. Membership exists from the first second,
   * because the account arrives with its own space. What has NOT changed is the
   * thing the rule actually keys on: keys exist once a chat is opened. Had the
   * rule been written against membership — which the old comment invited —
   * every new account would now be prompted to protect an empty keychain, and
   * the warning would name a history that does not exist.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → the rule still keys on keys, never on membership
   *   integrity → the reasoning no longer points at joining a topic
   *   integrity → both copies stay byte-identical, which is what keeps the web
   *               and the mini-app from drifting apart on this
   */
  const WEB = readFileSync(join(ROOT, 'src/lib/recoveryNudge.ts'), 'utf8');
  const MOBILE = readFileSync(join(ROOT, 'packages/mobile/src/lib/recoveryNudge.ts'), 'utf8');

  it('CONTRACT: the decision reads the backup signal, not membership', () => {
    const fn = WEB.slice(WEB.indexOf('export function shouldNudgeRecovery'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('input.backup');
    for (const wrong of ['member', 'topic', 'joined']) {
      expect(body.toLowerCase(), `the rule now keys on ${wrong}`).not.toContain(wrong);
    }
  });

  it('INTEGRITY: the reasoning no longer says "joined a topic"', () => {
    expect(WEB).not.toMatch(/once the user has joined a topic/);
  });

  it('INTEGRITY: the two copies are byte-identical', () => {
    // The comment is the part people read before changing the rule, so a fix
    // applied to one copy and not the other is how the clients drift.
    expect(MOBILE).toBe(WEB);
  });
});
