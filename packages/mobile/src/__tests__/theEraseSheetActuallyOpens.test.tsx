/**
 * Pressing a device-data control opens its sheet at once, and refuses a second
 * press while the first is being handled.
 *
 * WHAT ACTUALLY HAPPENED, and the correction. Driving the iPhone on 2026-08-28
 * I pressed "Erase from this device" twice and the screen never changed, and I
 * concluded the sheet could not render on this phone at all — nested inside the
 * screen's ScrollView. I wrote that into a commit message, twice, including a
 * claim that Android rendered the nesting and the iPhone did not.
 *
 * That was wrong. Narration added to the press showed nothing arriving at all,
 * and pressing the same control by coordinate produced every line: the press,
 * the sheet, the backup answer, the filled sheet. The automation tool had not
 * been landing on the button. The app was correct from the start.
 *
 * What survives is real, and neither part came from that mistaken diagnosis:
 *
 *   Opening waited on a network read — is there a key backup? — before showing
 *   anything. What follows is a local deletion; there is no reason for a round
 *   trip to stand between the press and the sheet. It opens first with a
 *   spinner and fills the answer in second. A cancel during that wait is not
 *   undone by the reply arriving afterwards.
 *
 *   Neither control refused a second press while the first was running. A
 *   destructive control that looks idle invites exactly that.
 *
 * The sheet also sits outside the scroll area now. That was not the fault, but
 * it is where a sheet covering the screen belongs, so it stays.
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
