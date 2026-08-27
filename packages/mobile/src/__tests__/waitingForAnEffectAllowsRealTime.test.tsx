/**
 * The harness's wait must give the work under test real TIME, not only ticks.
 *
 * THE FLAKE, seen once in a full-suite run on 2026-08-27 and never when the
 * file ran alone. The chain under test reaches a dynamic `import()`. Draining
 * microtasks 200 times costs about a millisecond, and a cold module load on a
 * machine running the whole suite in parallel takes far longer than that — so
 * the waiter ran out of budget and reported "the effect did not complete",
 * which reads as a defect in the code rather than as a stopwatch set too short.
 *
 * The first attempt at this guard asserted the wrong thing: that the loop was
 * STARVING the timer queue. Removing the fix did not break it, because `act`
 * already lets timers run. The axis that matters is elapsed time, so that is
 * what these measure.
 *
 * `.tsx`, not `.ts`, because it imports the render harness. The WEB config runs
 * this package's `.ts` logic tests in its own sweep and excludes the `.tsx`
 * ones — a `.ts` file that reaches into the harness is pulled into a project
 * with no react renderer installed, and fails there for a reason that has
 * nothing to do with what it asserts.
 */
import { describe, expect, it } from 'vitest';
import { flushUntil } from './harness/render';

/** True only once this much wall-clock time has actually passed. */
function afterMs(ms: number): () => boolean {
  const start = Date.now();
  return () => Date.now() - start >= ms;
}

describe('waiting for an effect allows real time to pass', () => {
  it('THE FLAKE: work that needs 60ms of real time is waited for', async () => {
    await expect(flushUntil(afterMs(60), { label: '60ms' })).resolves.toBeUndefined();
  });

  it('REPETITION: 150ms is waited for too — the budget is not a hair over', async () => {
    await expect(flushUntil(afterMs(150), { label: '150ms' })).resolves.toBeUndefined();
  });

  it('a condition already true costs nothing', async () => {
    const started = Date.now();
    await flushUntil(() => true, { label: 'already' });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('CONTRACT: a condition that never comes true still fails, and says so', async () => {
    await expect(flushUntil(() => false, { max: 3, label: 'never' })).rejects.toThrow(
      /never was still false after 3 ticks/,
    );
  });
});
