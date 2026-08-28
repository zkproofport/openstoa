/**
 * Pressing a device-data control opens its sheet, at once, and refuses a
 * second press while the first is being handled.
 *
 * WHAT HAPPENED, driving the iPhone on 2026-08-28. "Erase from this device"
 * was pressed twice and the screen never changed — no confirmation, no
 * spinner, nothing. The sheet's markup was in the shipped bundle and the
 * screen's state said open. Two separate faults were stacked:
 *
 *   The sheet was rendered INSIDE the screen's `ScrollView`. Nested there it
 *   did not appear at all on this phone. It is a sibling of the scroll area
 *   now, which is also where a full-screen sheet belongs.
 *
 *   Opening waited on a network read — the backup state — before showing
 *   anything. On a slow link that is a destructive control that looks dead.
 *   The sheet opens first and fills the answer in second.
 *
 * NOT a regression: one commit has ever touched these files, so the sheet has
 * been nested since it was written. It passed on Android, which renders that
 * nesting; the iPhone does not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const screen = read('../screens/profile/DeviceStorageScreen.tsx');
const sheet = read('../components/DeviceDataSheet.tsx');

describe('the erase sheet actually opens', () => {
  it('THE DEFECT: the sheet is NOT inside the scrolling area', () => {
    const at = screen.indexOf('<DeviceDataSheet');
    expect(at).toBeGreaterThan(-1);
    // Everything before it must have closed the scroll area already.
    const before = screen.slice(0, at);
    const opened = (before.match(/<ScrollView/g) ?? []).length;
    const closed = (before.match(/<\/ScrollView>/g) ?? []).length;
    expect(closed).toBe(opened);
  });

  it('THE DEFECT: the press opens the sheet before asking the server', () => {
    const at = screen.indexOf('const ask = useCallback');
    const ask = screen.slice(at, screen.indexOf('const proceed', at));
    // The open must come before the await, not after it.
    const opens = ask.indexOf("setStep('checking')");
    const asks = ask.indexOf('await keyBackupHttp');
    expect(opens).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(-1);
    expect(opens).toBeLessThan(asks);
  });

  it('CONTRACT: the sheet draws something while the answer is on its way', () => {
    expect(sheet).toContain("step === 'checking'");
    // A spinner and a way out — nothing that could be confirmed from here.
    expect(sheet).toContain('openstoa.deviceData.checking');
  });

  it('CONTRACT: both controls refuse a second press while one is running', () => {
    expect(screen).toMatch(/const busy = step === 'checking' \|\| step === 'running'/);
    // Both of them, not just the destructive one — a double clear is wasteful
    // and the disabled look is what tells someone the first press landed.
    expect((screen.match(/disabled=\{busy\}/g) ?? []).length).toBe(2);
  });

  it('INTEGRITY: cancelling while the answer is in flight is not undone by it', () => {
    // A reply nobody is waiting for must not reopen a sheet that was closed.
    expect(screen).toMatch(/setStep\(\(current\) => \(current === 'checking' \? 'confirm' : current\)\)/);
  });

  it('the sheet still shows nothing when nothing was asked for', () => {
    expect(sheet).toMatch(/if \(!step \|\| \(step !== 'checking' && !confirm\)\) return null;/);
  });
});
