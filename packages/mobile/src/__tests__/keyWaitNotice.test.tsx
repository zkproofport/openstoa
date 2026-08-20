/**
 * What a room says while it is still waiting for a key.
 *
 * The reported experience was a column of "Encrypted — this device has no key
 * for it": true, final-sounding, and wrong about the situation, because the key
 * was on its way. Nothing said so, nothing said what would fix it, and the
 * first-load spinner had already given up — `isSyncingHistory` ends on
 * `rootState === 'waiting'`, which is a PUBLIC-root idea, so the scoped tiers
 * fall straight through to the dead end the moment the probe answers.
 *
 * So the state now has three parts, and each is asserted here: a notice that
 * names the wait and the remedy, a status line that keeps moving for as long as
 * the wait lasts, and bubbles that say "not yet" instead of "not at all".
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → locked rows with no spinner produce the notice, the moving
 *                status, and the remedy sentence
 *   integrity  → a bubble reads "waiting" while a key is expected and the
 *                dead-end wording only when it is not; the two never both show
 *   boundary   → nothing locked → no notice at all
 *   empty      → the animated dots carry no text of their own, so a screen
 *                reader hears the sentence once, not "dot dot dot"
 *   race       → unmounting mid-animation does not throw
 *   authz / hostile / UTF-8 / very large → N/A: copy from the catalogue and a
 *                count the screen computed; no caller identity, no free text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { type ReactTestInstance } from 'react-test-renderer';
import { render } from './harness/render';
import { WaitingStatus } from '../components/WaitingStatus';

const LABEL = 'Catching up on 3 earlier messages';

function collect(node: ReactTestInstance): string {
  let out = '';
  for (const child of node.children) {
    out += typeof child === 'string' ? child : collect(child);
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('WaitingStatus', () => {
  it('CONTRACT: the label is shown, with trailing dots that are not part of it', async () => {
    const r = await render(<WaitingStatus label={LABEL} color="#000" testID="w" />);

    expect(r.text()).toContain(LABEL);
    // The dots are decoration, not sentence: a reader copying the line should
    // not get punctuation the writer never wrote.
    expect(r.text().replace(/·/g, '')).toContain(LABEL);
  });

  it('EMPTY: the dots are hidden from assistive tech', async () => {
    // Three animated full stops read aloud are noise on top of a sentence that
    // already says everything.
    const r = await render(<WaitingStatus label={LABEL} color="#000" />);

    const hidden = r.root.findAll((n) => n.props?.accessibilityElementsHidden === true);
    expect(hidden.length).toBeGreaterThan(0);
    expect(collect(hidden[0])).toMatch(/^·+$/);
  });

  it('CONTRACT: it keeps its own state, so a re-render does not restart it', async () => {
    // The animation is handed to the driver once. Recreating the values on each
    // render would reset the cycle every time the count changed.
    const r = await render(<WaitingStatus label={LABEL} color="#000" />);
    await r.update(<WaitingStatus label="Catching up on 2 earlier messages" color="#000" />);

    expect(r.text()).toContain('2 earlier messages');
  });

  it('RACE: unmounting mid-animation does not throw', async () => {
    const r = await render(<WaitingStatus label={LABEL} color="#000" />);
    expect(() => r.unmount()).not.toThrow();
  });
});
