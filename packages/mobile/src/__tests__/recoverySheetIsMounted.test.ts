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
 * WHY A SOURCE SCAN. Rendering `OpenStoaApp` needs a navigator, a query client,
 * a host bridge and a session — and the thing under test is one JSX element's
 * PRESENCE. A scan answers that directly; comments are stripped first, because
 * a scan a comment can satisfy proves nothing (which happened twice today).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the sheet is rendered in the authenticated tree
 *   contract  → it is fed by the wiring hook, not by ad-hoc state
 *   integrity → it sits beside the navigator, not inside a screen
 *   integrity → the copy handler is passed, or the button is decorative
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'OpenStoaApp.tsx');

/** Source with comments removed. */
const SRC = readFileSync(APP, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\/.*$/gm, '');

describe('the recovery sheet is mounted at the root', () => {
  it('CONTRACT: the sheet is rendered', () => {
    expect(SRC).toContain('<FirstRunRecoverySheet');
  });

  it('CONTRACT: it is fed by the wiring hook', () => {
    // Not local state. The hook is what guarantees one creation per launch.
    expect(SRC).toContain('useFirstRunRecovery(');
    expect(SRC).toMatch(/prompt=\{recovery\.prompt\}/);
    expect(SRC).toMatch(/code=\{recovery\.code\}/);
  });

  it('INTEGRITY: it sits beside the navigator, not inside a screen', () => {
    /*
     * The push-registration lesson, applied. Mounted under a tab, an account
     * that never opens that tab is never asked — and this is the one thing that
     * cannot be repaired afterwards.
     */
    const navAt = SRC.indexOf('<OpenStoaTabNavigator');
    const sheetAt = SRC.indexOf('<FirstRunRecoverySheet');
    expect(navAt).toBeGreaterThan(-1);
    expect(sheetAt).toBeGreaterThan(navAt);
  });

  it('INTEGRITY: the copy handler is wired, or the button does nothing', () => {
    expect(SRC).toMatch(/onCopy=\{copyRecoveryCode\}/);
  });

  it('CONTRACT: both outcomes are wired and they are different', () => {
    // `stored` and `dismiss` write different marks; passing one for both would
    // make a dismissed sheet look like a completed one.
    expect(SRC).toMatch(/onStored=\{recovery\.onStored\}/);
    expect(SRC).toMatch(/onDismiss=\{recovery\.onDismiss\}/);
  });
});
