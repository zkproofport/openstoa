/*
 * The recovery sheet is actually mounted, at the root, for every signed-in
 * account.
 *
 * WHY THIS IS ITS OWN FILE. The decision (`recoveryPrompt`), the drawing
 * (`FirstRunRecoverySheet`) and the wiring (`useFirstRunRecovery`) each have
 * their own guards, and all three can be green while nothing renders — because
 * nobody mounted it. That is not hypothetical in this codebase: push
 * registration used to hang off `ChatListScreen`, so an account that never
 * opened the chat list never registered and never received a push. The comment
 * at the mount site says so.
 *
 * The same shape here is worse than a missing push. `master_key` is generated on
 * the phone and never leaves; without a wrap of it, a lost phone takes every
 * encrypted room with it, permanently. An unmounted sheet is an account that is
 * never asked.
 *
 * WHY IT NOW SCANS TWO FILES. The mount used to be JSX inside `OpenStoaApp`;
 * it is now `FirstRunRecoveryProvider`, which the app mounts and which renders
 * the sheet. That is one indirection, and an indirection is a place a chain can
 * break in the middle while both ends still look wired — the app mounting a
 * provider that renders nothing, or a provider rendering a sheet nobody mounts.
 * So both links are asserted, plus a whole-tree scan proving the sheet has
 * exactly ONE mount site, so it cannot quietly reappear under a tab.
 *
 * WHY A SOURCE SCAN. Rendering `OpenStoaApp` needs a navigator, a query client,
 * a host bridge and a session — and the thing under test is one JSX element's
 * PRESENCE. A scan answers that directly; comments are stripped first, because
 * a scan a comment can satisfy proves nothing (which happened twice today), and
 * a comment in `OpenStoaApp.tsx` names `FirstRunRecoveryProvider` already.
 *
 * WHAT A SCAN CANNOT SAY is whether the provider does anything once mounted.
 * `recoveryNoteFiledFromTheSheet.test.tsx` mounts it for real and asserts the
 * sheet appears, the children still render, and the note is filed — the two
 * files together are the chain end to end.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the app mounts the provider, and it WRAPS the navigator
 *   contract  → the provider renders the sheet
 *   contract  → the sheet is fed by the wiring hooks, not by ad-hoc state
 *   integrity → the app imports the provider from the file that renders it
 *   integrity → exactly one file in the mini-app mounts the sheet
 *   integrity → the copy handler is passed, or the button is decorative
 *   integrity → `stored` and `dismiss` are wired and are different handlers
 *   boundary / hostile / empty / UTF-8 / large / authz / race — N/A: this file
 *               is about WHERE a component is mounted. What it does once
 *               mounted is `recoveryNoteFiledFromTheSheet.test.tsx`, and what
 *               it draws is `firstRunRecoverySheet.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/**
 * Strip line and block comments — including JSX `{/* … *\/}`, which is a block
 * comment in braces.
 *
 * Prose ABOUT the mount is fine and there is plenty of it: `OpenStoaApp.tsx`
 * discusses `FirstRunRecoveryProvider` by name, and `FirstRunRecovery.tsx`
 * opens with a paragraph about `FirstRunRecoverySheet`. Only what is RENDERED
 * counts here, which is the whole reason this runs first.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function read(...parts: string[]): string {
  return stripComments(readFileSync(join(SRC, ...parts), 'utf8'));
}

const APP = read('OpenStoaApp.tsx');
const PROVIDER = read('components', 'FirstRunRecovery.tsx');

/**
 * An actual JSX mount, not an identifier that merely starts with the name —
 * the same distinction `recoveryNudgeProfileOnly.test.tsx` had to make when
 * `<RecoveryNudgeContext.Provider>` counted as a second banner.
 */
const RENDERS_SHEET = /<FirstRunRecoverySheet[\s/>]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // __tests__ is excluded: this very file names the element it asserts on.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the app mounts the recovery provider', () => {
  it('CONTRACT: the provider is rendered at the root', () => {
    expect(
      APP,
      'nothing mounts FirstRunRecoveryProvider — the sheet is reachable only from its own tests again',
    ).toMatch(/<FirstRunRecoveryProvider[\s>]/);
  });

  it('CONTRACT: it WRAPS the navigator rather than sitting beside a screen', () => {
    /*
     * The push-registration lesson, applied. Mounted under a tab, an account
     * that never opens that tab is never asked — and this is the one thing that
     * cannot be repaired afterwards. Asserted as "opens before the navigator and
     * closes after it" rather than as one exact string, so reordering the two
     * providers (which is free) does not read as the mount being lost (which is
     * not).
     */
    const open = APP.indexOf('<FirstRunRecoveryProvider');
    const nav = APP.indexOf('<OpenStoaTabNavigator');
    const close = APP.indexOf('</FirstRunRecoveryProvider>');

    expect(nav, 'the navigator is not mounted here at all').toBeGreaterThan(-1);
    expect(open, 'the provider is not mounted here at all').toBeGreaterThan(-1);
    expect(open, 'the provider is mounted after the navigator, so it wraps nothing').toBeLessThan(
      nav,
    );
    expect(close, 'the provider closes before the navigator — the navigator is outside it').toBeGreaterThan(
      nav,
    );
  });

  it('INTEGRITY: it is imported from the file that actually renders the sheet', () => {
    // Both halves are scanned below, and this is the line that says they are
    // the SAME provider — otherwise a second, empty `FirstRunRecovery` module
    // would satisfy both scans while rendering nothing.
    expect(APP).toMatch(
      /import\s*\{\s*FirstRunRecoveryProvider\s*\}\s*from\s*'\.\/components\/FirstRunRecovery'/,
    );
  });
});

describe('the provider mounts the sheet', () => {
  it('CONTRACT: the sheet is rendered', () => {
    expect(RENDERS_SHEET.test(PROVIDER), 'the provider renders no sheet').toBe(true);
  });

  it('CONTRACT: it is fed by the wiring hooks', () => {
    // Not local state. `useFirstRunRecovery` is what guarantees ONE creation
    // per launch, and `useRecoveryCodeSource` is what refuses to ask before the
    // server has answered.
    expect(PROVIDER).toContain('useFirstRunRecovery(');
    expect(PROVIDER).toContain('useRecoveryCodeSource(');
    expect(PROVIDER).toMatch(/prompt=\{prompt\}/);
    expect(PROVIDER).toMatch(/code=\{code\}/);
  });

  it('INTEGRITY: the copy handler is wired, or the button does nothing', () => {
    expect(PROVIDER).toMatch(/onCopy=\{onCopy\}/);
  });

  it('CONTRACT: both outcomes are wired and they are different', () => {
    // `stored` and `dismiss` write different marks; passing one for both would
    // make a dismissed sheet look like a completed one.
    expect(PROVIDER).toMatch(/onStored=\{onStored\}/);
    expect(PROVIDER).toMatch(/onDismiss=\{onDismiss\}/);
  });

  it('INTEGRITY: exactly one file in the mini-app mounts the sheet', () => {
    /*
     * A second mount is not a harmless duplicate. The sheet's `onStored` writes
     * the mark that stops it ever being shown again, and two of them racing
     * means one gets dismissed while the other records "saved". Scanning the
     * whole tree also catches the shape this file was written for arriving from
     * the other direction: someone re-mounting the sheet inside a screen,
     * where an account that never opens that tab is never asked.
     */
    const mounts = walk(SRC)
      .filter((file) => RENDERS_SHEET.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(/[\\/]/).join('/'))
      .sort();

    expect(mounts).toEqual(['components/FirstRunRecovery.tsx']);
  });
});
