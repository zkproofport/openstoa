/**
 * A personal space must not describe people who will never exist.
 *
 * THE DEFECT, seen on a real phone. Opening the space showed the standard
 * retention notice: "This topic keeps its chat archive indefinitely, so a
 * member who joins later can read the whole conversation."
 *
 * Nobody joins this room later. Every door answers 403 — that is the entire
 * point of the feature. The sentence describes a future member who cannot
 * exist, and in doing so quietly suggests the space could be shared after all,
 * which is precisely the thing the owner is relying on being untrue.
 *
 * Both standard notes have this shape, because retention IS a statement about
 * who can read the history later. Neither can be reused here; the space needs
 * its own sentence.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the personal note exists in every locale
 *   integrity → it says nothing about anyone else joining or reading
 *   contract  → the screen picks it on the flag, ahead of the retention rules
 *   boundary  → ordinary topics keep the standard notes untouched
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = readFileSync(join(SRC, 'screens/topics/TopicDetailScreen.tsx'), 'utf8');
const locale = (l: string) =>
  JSON.parse(readFileSync(join(SRC, `i18n/locales/${l}.json`), 'utf8')).openstoa.topicDetail
    .archiveRetention as Record<string, string>;

describe('what a personal space says about its history', () => {
  it('CONTRACT: every locale has the personal note', () => {
    for (const l of ['en', 'ko']) {
      expect(locale(l).notePersonal, `${l} is missing notePersonal`).toBeTruthy();
    }
  });

  it('INTEGRITY: it promises nothing about anyone else', () => {
    /*
     * The English is checked by wording because that is where the false
     * promise lived. Korean is checked for the same absence — a translation
     * that reintroduces "나중에 들어온 멤버" would be the same defect in the
     * language most of these users read.
     */
    const en = locale('en').notePersonal.toLowerCase();
    for (const forbidden of ['joins later', 'a member who', 'other members', 'everyone']) {
      expect(en, `the personal note still talks about ${forbidden}`).not.toContain(forbidden);
    }
    expect(locale('ko').notePersonal).not.toMatch(/합류|들어온 멤버|다른 멤버/);
  });

  it('CONTRACT: the screen chooses it on the flag, before the retention rules', () => {
    // If the retention branch is evaluated first, an unlimited personal space
    // gets the standard sentence and the fix does nothing.
    const at = SCREEN.indexOf('notePersonal');
    const unlimited = SCREEN.indexOf('noteUnlimited');
    expect(at, 'the screen never uses the personal note').toBeGreaterThan(-1);
    expect(at).toBeLessThan(unlimited);
    expect(SCREEN.slice(Math.max(0, at - 120), at)).toContain('topic.personal');
  });

  it('BOUNDARY: ordinary topics keep both standard notes', () => {
    // The point is one extra case, not a rewrite of what other topics say.
    for (const l of ['en', 'ko']) {
      expect(locale(l).noteUnlimited).toBeTruthy();
      expect(locale(l).noteWindowed).toBeTruthy();
    }
    expect(SCREEN).toContain('noteWindowed');
  });
});
