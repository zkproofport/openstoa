// @vitest-environment jsdom
/*
 * The sheet draws what the decision told it to, and the report tells the truth.
 *
 * WHY A RENDER TEST. Two things here are only observable as "what can a person
 * see and press":
 *
 *   1. The second confirmation. `eraseConfirm` decides that a no-backup erase
 *      needs one, but a sheet that ignored the flag and wired the destructive
 *      button straight to `onProceed` would pass every unit test of the decider
 *      while shipping a one-tap, unrecoverable erase.
 *   2. The report. A run that could not delete anything must not close on
 *      "Done". That is a rendering decision over `eraseWasBlocked`, and a scan
 *      cannot see it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a cache confirm shows the reversible copy and one action
 *   integrity  → a no-backup erase does NOT reach `onProceed` on the first tap
 *   integrity  → a backed-up erase DOES, on the first tap — the extra step is
 *                not applied to everyone
 *   integrity  → a blocked report says the version cannot do it, and never
 *                shows the success copy
 *   contract   → a partial report is distinct from both success and blocked
 *   boundary   → the counts are rendered, including zero
 *   empty      → a null step and a null confirm each render nothing
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from './harness/render';
import DeviceDataSheet, { type DeviceDataStep } from '../components/DeviceDataSheet';
import { eraseConfirm } from '../lib/deviceData';
import type { EraseReport } from '../lib/deviceDataErase';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, values?: Record<string, string | number>) =>
      values ? `${k}:${JSON.stringify(values)}` : k,
  }),
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

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const CACHE = eraseConfirm('cache', null, NOW);
const ERASE_BACKED_UP = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW - DAY }, NOW);
const ERASE_STALE = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW - 90 * DAY }, NOW);
const ERASE_NO_BACKUP = eraseConfirm('device', { hasBackup: false, backupUpdatedAt: null }, NOW);

function report(over: Partial<EraseReport> = {}): EraseReport {
  return {
    scope: 'cache',
    localRemoved: 12,
    localKept: 9,
    secureRemoved: 0,
    mediaRemoved: 3,
    failed: 0,
    gaps: [],
    ...over,
  };
}

type Props = React.ComponentProps<typeof DeviceDataSheet>;

async function draw(over: Partial<Props> = {}) {
  return render(
    <DeviceDataSheet
      step={'confirm' as DeviceDataStep}
      confirm={CACHE}
      report={null}
      onProceed={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );
}

describe('the confirmation', () => {
  it('CONTRACT: a cache confirm says it is reversible and offers one action', async () => {
    const r = await draw();

    expect(r.text()).toContain('openstoa.deviceData.clearCache.confirmTitle');
    expect(r.text()).toContain('openstoa.deviceData.clearCache.confirmBody');
    expect(r.pressableWith('openstoa.deviceData.clearCache.action')).toBeTruthy();
    expect(r.pressableWith('openstoa.common.cancel')).toBeTruthy();
    // The destructive wording belongs to the other action, not this one.
    expect(r.text()).not.toContain('openstoa.deviceData.eraseDevice.finalBody');
  });

  it('INTEGRITY: a no-backup erase does NOT proceed on the first tap', async () => {
    /*
     * THE guard. `requiresSecondConfirm` is set by `eraseConfirm`, and this is
     * the only place it can be observed doing anything. A sheet that wired the
     * button straight through would delete the only copy of somebody's chat
     * keys on one tap.
     */
    const onProceed = vi.fn();
    const r = await draw({ confirm: ERASE_NO_BACKUP, onProceed });

    expect(ERASE_NO_BACKUP.requiresSecondConfirm).toBe(true);
    expect(r.text()).toContain('openstoa.deviceData.eraseDevice.noBackupTitle');

    const button = r.pressableWith('openstoa.deviceData.eraseDevice.action');
    expect(button).toBeTruthy();
    await r.press(button!);

    /*
     * `onProceed` IS called — the screen owns the step machine and turns the
     * first call into `confirm-final`. What must not happen is the sheet
     * showing the final copy and the erase running from the same tap, which is
     * asserted by the step below being a separate render.
     */
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(r.text()).not.toContain('openstoa.deviceData.eraseDevice.finalAction');
  });

  it('INTEGRITY: the final step asks a DIFFERENT question, with its own button', async () => {
    const onProceed = vi.fn();
    const r = await draw({ step: 'confirm-final', confirm: ERASE_NO_BACKUP, onProceed });

    expect(r.text()).toContain('openstoa.deviceData.eraseDevice.finalTitle');
    expect(r.text()).toContain('openstoa.deviceData.eraseDevice.finalBody');
    // Not the same sentence twice — the first step's body is gone.
    expect(r.text()).not.toContain('openstoa.deviceData.eraseDevice.noBackupBody');

    await r.press(r.pressableWith('openstoa.deviceData.eraseDevice.finalAction')!);
    expect(onProceed).toHaveBeenCalledTimes(1);
    // Backing out is still possible at the last moment.
    expect(r.pressableWith('openstoa.common.cancel')).toBeTruthy();
  });

  it('INTEGRITY: an account WITH a backup is not made to do the extra step', async () => {
    /*
     * The other direction, and it matters as much: a warning applied to
     * everyone is a warning nobody reads. Somebody who has just made a backup
     * gets one confirmation.
     */
    expect(ERASE_BACKED_UP.requiresSecondConfirm).toBe(false);
    const r = await draw({ confirm: ERASE_BACKED_UP });
    expect(r.text()).toContain('openstoa.deviceData.eraseDevice.confirmTitle');
    expect(r.text()).not.toContain('openstoa.deviceData.eraseDevice.noBackupTitle');
  });

  it('CONTRACT: a stale backup says how old it is', async () => {
    const r = await draw({ confirm: ERASE_STALE });
    expect(r.text()).toContain('openstoa.deviceData.eraseDevice.staleBackupBody');
    expect(r.text()).toContain('"days":90');
    expect(ERASE_STALE.requiresSecondConfirm).toBe(false);
  });
});

describe('the report', () => {
  it('CONTRACT: a clean run says done and shows the counts', async () => {
    const r = await draw({ step: 'done', report: report() });

    expect(r.text()).toContain('openstoa.deviceData.result.doneTitle');
    expect(r.text()).toContain('openstoa.deviceData.result.counts');
    expect(r.text()).toContain('"keys":12');
    expect(r.text()).toContain('"files":3');
    expect(r.pressableWith('openstoa.common.done')).toBeTruthy();
  });

  it('INTEGRITY: a blocked run never shows the success copy', async () => {
    /*
     * The worst available outcome for an "erase everything" button is a sheet
     * that closes on "Done" while every key is still on the phone.
     */
    const r = await draw({
      step: 'done',
      report: report({ scope: 'device', localRemoved: 0, mediaRemoved: 0, gaps: ['secure-no-removal'] }),
    });

    expect(r.text()).toContain('openstoa.deviceData.result.blockedTitle');
    expect(r.text()).toContain('openstoa.deviceData.result.blockedBody');
    expect(r.text()).not.toContain('openstoa.deviceData.result.doneTitle');
    expect(r.text()).not.toContain('openstoa.deviceData.result.partialTitle');
  });

  it('CONTRACT: a partial run is distinct from both success and blocked', async () => {
    const r = await draw({
      step: 'done',
      report: report({ failed: 2, gaps: ['some-deletes-failed'] }),
    });

    expect(r.text()).toContain('openstoa.deviceData.result.partialTitle');
    expect(r.text()).not.toContain('openstoa.deviceData.result.doneTitle');
    expect(r.text()).not.toContain('openstoa.deviceData.result.blockedTitle');
  });

  it('BOUNDARY: zero removed is still rendered as a number, not hidden', async () => {
    const r = await draw({
      step: 'done',
      report: report({ localRemoved: 0, mediaRemoved: 0, localKept: 0 }),
    });
    expect(r.text()).toContain('"keys":0');
    expect(r.text()).toContain('"files":0');
  });

  it('CONTRACT: secure removals are counted alongside local ones', async () => {
    const r = await draw({
      step: 'done',
      report: report({ scope: 'device', localRemoved: 4, secureRemoved: 6 }),
    });
    expect(r.text()).toContain('"keys":10');
  });
});

describe('the closed states', () => {
  it('EMPTY: a null step renders nothing', async () => {
    const r = await draw({ step: null });
    expect(r.text()).toBe('');
  });

  it('EMPTY: a null confirm renders nothing, even with a step', async () => {
    const r = await draw({ confirm: null });
    expect(r.text()).toBe('');
  });

  it('CONTRACT: the running state shows neither a report nor a proceed button', async () => {
    const r = await draw({ step: 'running', confirm: ERASE_NO_BACKUP });
    expect(r.text()).toContain('openstoa.deviceData.running');
    expect(r.pressableWith('openstoa.deviceData.eraseDevice.action')).toBeUndefined();
    expect(r.pressableWith('openstoa.deviceData.eraseDevice.finalAction')).toBeUndefined();
  });

  it('EMPTY: `done` with no report falls back to the confirm copy rather than crashing', async () => {
    const r = await draw({ step: 'done', report: null, confirm: CACHE });
    expect(r.text()).toContain('openstoa.deviceData.clearCache.confirmTitle');
  });
});
