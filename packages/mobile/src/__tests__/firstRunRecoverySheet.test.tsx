// @vitest-environment jsdom
/*
 * The recovery sheet draws what the decision told it to, and never more.
 *
 * WHY A RENDER TEST AND NOT A SOURCE SCAN. What matters here is what a person
 * can DO: whether the key is on screen, and whether "I have saved it" is
 * offerable before there is anything to have saved. A scan sees neither.
 *
 * THE CASE THAT MATTERS is the last one. `stored` and `dismiss` write different
 * marks, and if the confirm button is reachable while the key is still being
 * created, one tap records that somebody saved a key they never saw — and
 * `recoveryPrompt` then never asks again. That is the difference between a
 * prompt and a trap.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → a `show` prompt renders the key and both actions
 *   contract  → the body differs by reason; a first run and a bare account are
 *               being told different things
 *   integrity → `stored` is NOT offered while the key is still being made
 *   integrity → `stored` is NOT offered when creation failed
 *   boundary  → `none` renders nothing at all
 *   empty     → a null prompt renders nothing
 *   external  → a failure shows the failure copy rather than hanging on "…"
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from './harness/render';
import FirstRunRecoverySheet from '../components/FirstRunRecoverySheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../theme/ThemeContext', () => ({
  useThemeColors: () => ({
    colors: {
      background: { primary: '#000' },
      border: { default: '#333' },
      brand: { primary: '#7c5cff' },
      text: { primary: '#fff', secondary: '#aaa', inverted: '#000' },
      status: { success: '#0f0', warning: '#fa0', danger: '#f00' },
    },
  }),
}));

const noop = () => {};
const CODE = 'abcd-efgh-ijkl-mnop';

type Props = React.ComponentProps<typeof FirstRunRecoverySheet>;

async function draw(over: Partial<Props> = {}) {
  return render(
    <FirstRunRecoverySheet
      prompt={{ kind: 'show', reason: 'first-run' }}
      code={CODE}
      onCopy={noop}
      onStored={noop}
      onDismiss={noop}
      {...over}
    />,
  );
}

describe('the first-run recovery sheet', () => {
  it('CONTRACT: a show prompt renders the key and both actions', async () => {
    const r = await draw();

    expect(r.text()).toContain(CODE);
    expect(r.pressableWith('openstoa.firstRunRecovery.stored')).toBeTruthy();
    expect(r.pressableWith('openstoa.firstRunRecovery.later')).toBeTruthy();
  });

  it('CONTRACT: the body differs by reason', async () => {
    /*
     * Not cosmetic. A first run is learning how the product works; an account
     * that has gone without a backup is being told about a risk it already
     * carries.
     */
    const first = await draw({ prompt: { kind: 'show', reason: 'first-run' } });
    const bare = await draw({ prompt: { kind: 'show', reason: 'no-backup' } });

    expect(first.text()).toContain('openstoa.firstRunRecovery.bodyFirstRun');
    expect(first.text()).not.toContain('openstoa.firstRunRecovery.bodyNoBackup');
    expect(bare.text()).toContain('openstoa.firstRunRecovery.bodyNoBackup');
  });

  it('INTEGRITY: "I have saved it" is not offered while the key is being made', async () => {
    /*
     * THE guard. One tap here records that a key was stored which was never on
     * screen, and `recoveryPrompt` then never asks again.
     */
    const r = await draw({ code: null });

    expect(r.pressableWith('openstoa.firstRunRecovery.stored')).toBeUndefined();
    expect(r.text()).toContain('openstoa.firstRunRecovery.generating');
    // Leaving is still possible — a slow network must not trap anyone.
    expect(r.pressableWith('openstoa.firstRunRecovery.later')).toBeTruthy();
  });

  it('INTEGRITY: "I have saved it" is not offered when creation failed', async () => {
    const r = await draw({ code: null, error: 'boom' });

    expect(r.pressableWith('openstoa.firstRunRecovery.stored')).toBeUndefined();
    expect(r.text()).toContain('openstoa.firstRunRecovery.failed');
  });

  it('EXTERNAL: a failure says so rather than hanging on "creating…"', async () => {
    const r = await draw({ code: null, error: 'boom' });
    expect(r.text()).not.toContain('openstoa.firstRunRecovery.generating');
  });

  it('BOUNDARY: a none prompt renders nothing', async () => {
    const r = await draw({ prompt: { kind: 'none' } });
    expect(r.text()).toBe('');
  });

  it('EMPTY: a null prompt renders nothing', async () => {
    const r = await draw({ prompt: null });
    expect(r.text()).toBe('');
  });
});
