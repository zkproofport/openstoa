/**
 * An account without its own space is an account the feature forgot.
 *
 * The space is made where the ACCOUNT is made, so a person finds it already
 * there on their first sign-in rather than having to discover a button. That
 * puts the obligation on every path that can create an account — and there is
 * more than one: `ensureUser` covers the mobile proof poll and the AI verifier,
 * while `dev-login` inserts its own row because it carries a caller-supplied
 * nickname.
 *
 * WHY A SOURCE SCAN. The failure is silent and delayed: an account created down
 * a path that forgot the call works perfectly, and the absence only shows up
 * later as "where is my space", by which time the sign-in that caused it is
 * long gone from the logs. A new sign-in path is exactly the kind of change
 * that would add another `insert(users)` and not think about this.
 *
 * The scan is derived from the source rather than from a hand-kept list, so a
 * THIRD creation path added tomorrow fails this test on the day it appears.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → every account-creating path also creates the space
 *   integrity → the scan finds the paths itself; no hardcoded list to go stale
 *   boundary  → a file that creates an account and nothing else is caught
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('every path that creates an account creates its space', () => {
  const creators = walk(ROOT)
    .map((f) => ({ file: f.slice(ROOT.length + 1), src: stripComments(readFileSync(f, 'utf8')) }))
    .filter(({ src }) => /insert\(\s*users\s*\)/.test(src));

  it('BOUNDARY: the scan actually found the creation paths', () => {
    /*
     * A scan that matches nothing passes every assertion below while checking
     * nothing at all — the way this kind of test rots when the code it reads
     * is renamed or moved.
     */
    expect(creators.length).toBeGreaterThanOrEqual(2);
  });

  it('CONTRACT: each of them calls ensurePersonalTopic', () => {
    const forgot = creators
      .filter(({ src }) => !/ensurePersonalTopic\s*\(/.test(src))
      .map(({ file }) => file);
    expect({ accountPathsWithoutASpace: forgot }).toEqual({ accountPathsWithoutASpace: [] });
  });

  it('CONTRACT: an account that ALREADY EXISTS gets one too, on any sign-in', () => {
    /*
     * The half this file used to miss, and the reason a staging member had a
     * chat list with their topics in it and no "My space" at all.
     *
     * `ensureUser` returns early for an account it finds — that is the whole
     * point of the function — and the early return skipped `ensurePersonalTopic`
     * entirely. So every account created before that function existed had no
     * space and never would, while two comments (here and in `personalTopic.ts`)
     * said it "will be made on their next sign-in". It was not.
     *
     * Asserted on the EXISTING branch specifically. The creation branch is
     * covered above, and a fix that only satisfied that one would leave the
     * accounts this is for exactly where they were.
     */
    const src = readFileSync(join(ROOT, 'lib', 'ensureUser.ts'), 'utf8');
    const earlyReturn = src.slice(
      src.indexOf('if (existing)'),
      src.indexOf('created: false }'),
    );
    expect(earlyReturn, 'ensureUser: the existing-account branch must ensure the space').toMatch(
      /ensurePersonalTopic\(\s*nullifier\s*\)/,
    );
  });

  it('INTEGRITY: the space is made for the account that was just created', () => {
    /*
     * Passing the wrong id is the mistake this shape invites — both files have
     * a session user in scope as well as the new account. It would make a
     * second space for whoever was signed in and leave the new account with
     * none, and both halves would be silent.
     */
    for (const { file, src } of creators) {
      const insert = src.match(/insert\(\s*users\s*\)\.values\(\{\s*id:\s*(\w+)/);
      expect(insert, `${file}: could not read the inserted id`).toBeTruthy();
      const idVar = insert![1];
      expect(src, `${file}: the space is made for a different id`).toMatch(
        new RegExp(`ensurePersonalTopic\\(\\s*${idVar}\\s*\\)`),
      );
    }
  });
});
