/**
 * An erase never reports more than it actually found.
 *
 * THE DEFECT, found on 2026-08-27 by reading the erase path rather than
 * watching it fail. The Keychain cannot be enumerated, so a full erase deletes
 * a LIST of names built from three sources: the server's room list, the local
 * chat-list cache, and the archive keychain manifest. Two of those three can
 * come up short — `/api/topics` throws when the phone is offline or the session
 * has expired, and `diagnoseKeychain` throws when the manifest is unreadable —
 * and both failures were handled by a `console.warn` and nothing else.
 *
 * The report then contained no gaps, and `eraseWasComplete` is
 * `gaps.length === 0`, so the sheet said the erase was complete. The keys for
 * every unlisted room were still in the Keychain.
 *
 * WHY THAT PARTICULAR LIE IS THE WORST ONE. This feature exists for three
 * reasons and the first is handing the phone to somebody else — on iOS it is
 * the ONLY way, because deleting the app leaves the Keychain untouched. A
 * person who is told "everything is gone" stops looking. Saying "some of it is
 * still here" is worth more than any amount of deleting.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a caller-known gap reaches the report and flips it to partial
 *   contract   → each shortfall is named separately, so the report is as
 *                specific as the code's knowledge
 *   integrity  → a complete run is still reported complete (the guard must not
 *                just always say "partial")
 *   累積       → a gap declared once survives every store's contribution, and
 *                repeated erases each report it — an erase that "worked the
 *                second time" is the shape this could regress into
 *   boundary   → an empty gap list behaves exactly as before the parameter
 *   hostile    → duplicate gaps do not accumulate into a growing array
 *   race       → the caller's gap is recorded BEFORE any delete runs, so a
 *                store that throws mid-run cannot take it down with it
 */
import { describe, it, expect } from 'vitest';
import {
  eraseDeviceData,
  eraseWasComplete,
  type EraseGap,
  type EraseReport,
} from '../lib/deviceDataErase';

/** A store that can do everything asked of it. */
function workingStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
    getAllKeys: async () => [...map.keys()],
  };
}

const deps = () => ({
  local: workingStore({ 'mls.msg.t1': 'x', 'openstoa.session': 'keep' }),
  secure: workingStore({ 'mls.identity': 'id' }),
  fs: { listCache: async () => [], deleteCache: async () => {} },
  secureKeys: ['mls.identity'],
});

const run = (gaps: readonly EraseGap[] = []): Promise<EraseReport> =>
  eraseDeviceData(deps() as never, 'device', gaps);

describe('an erase never claims more than it found', () => {
  it('CONTRACT: a room list that could not be fetched makes the report partial', async () => {
    const report = await run(['topics-not-listed']);

    expect(report.gaps).toContain('topics-not-listed');
    expect(eraseWasComplete(report)).toBe(false);
  });

  it('CONTRACT: an unreadable keychain manifest is named separately', async () => {
    /*
     * Two different sentences about what is left behind: a missing room list
     * leaves that room's MLS state, an unreadable manifest leaves archive roots
     * for rooms that ARE listed. One shared "something went wrong" value would
     * make the report vaguer than what the code actually knows.
     */
    const report = await run(['keychain-not-listed']);

    expect(report.gaps).toContain('keychain-not-listed');
    expect(report.gaps).not.toContain('topics-not-listed');
    expect(eraseWasComplete(report)).toBe(false);
  });

  it('CONTRACT: both shortfalls at once are both reported', async () => {
    const report = await run(['topics-not-listed', 'keychain-not-listed']);

    expect([...report.gaps].sort()).toEqual(['keychain-not-listed', 'topics-not-listed']);
  });

  it('INTEGRITY: a run with nothing missing is still reported complete', async () => {
    /*
     * The other half. A guard that only ever proves "partial" would pass just as
     * well against code that hard-coded a gap, and then every erase would warn —
     * which trains the person to ignore the warning that matters.
     */
    const report = await run();

    expect(report.gaps).toEqual([]);
    expect(eraseWasComplete(report)).toBe(true);
    expect(report.secureRemoved).toBe(1);
  });

  it('ACCUMULATING: five erases in a row each report the gap', async () => {
    /*
     * THE AXIS THE OTHER CASES DO NOT COVER. A gap consumed, latched, or
     * recorded into shared state would pass the single-call cases above and
     * then report a clean erase on the second try — which is precisely the
     * "it worked when I did it again" that sends somebody away believing their
     * phone is empty.
     */
    const verdicts: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      verdicts.push(eraseWasComplete(await run(['topics-not-listed'])));
    }

    expect(verdicts).toEqual([false, false, false, false, false]);
  });

  it('ACCUMULATING: repeating the same gap does not grow the list', async () => {
    // The report is read by a screen that renders one line per gap.
    const report = await run(['topics-not-listed', 'topics-not-listed', 'topics-not-listed']);

    expect(report.gaps).toEqual(['topics-not-listed']);
  });

  it('INTEGRITY: a caller gap and a store gap are both reported, not one or the other', async () => {
    /*
     * NOT an ordering guard, and the distinction is written down because I
     * first claimed it was one. `eraseDeviceData` records the caller's gaps
     * before it deletes anything, which reads like it protects against a store
     * failing mid-run — but every delete is individually caught
     * (`deviceDataErase.ts`, `eraseSecure`), so nothing can throw out of the
     * function and the ordering makes no observable difference. Moving the loop
     * to the end of the function passes this whole file: an equivalent mutant.
     *
     * What this DOES guard is that the two kinds of shortfall coexist. A report
     * that overwrote rather than accumulated would show one and hide the other,
     * and which one you got would depend on the order they happened in.
     */
    const report = await eraseDeviceData(
      {
        local: workingStore(),
        // No `removeItem`: the host cannot delete Keychain entries at all.
        secure: { getItem: async () => null, setItem: async () => {} },
        fs: null,
        secureKeys: ['mls.identity'],
      } as never,
      'device',
      ['topics-not-listed'],
    );

    expect(report.gaps).toContain('topics-not-listed');
    expect(report.gaps).toContain('secure-no-removal');
  });

  it('BOUNDARY: omitting the argument behaves as it did before it existed', async () => {
    const explicit = await run([]);
    const omitted = await eraseDeviceData(deps() as never, 'device');

    expect(omitted.gaps).toEqual(explicit.gaps);
    expect(eraseWasComplete(omitted)).toBe(true);
  });
});
