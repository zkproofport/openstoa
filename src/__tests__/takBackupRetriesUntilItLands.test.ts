/**
 * The TAK keychain backup keeps trying until the server has it.
 *
 * THE DEFECT. The upload ran once, 1.5s after a keychain write, and on failure
 * the code said — in a comment, which is not a mechanism — "retried on the next
 * keychain change". The person this feature exists for is the one who reads
 * more than they write: they may not touch a key for weeks, so one failed
 * upload meant no backup at all. They would still be handed a recovery code,
 * and it would come back and open nothing.
 *
 * Silent on both sides: a `console.warn` nobody reads, and a server row that
 * simply is not there. Nothing in the product would ever have said so.
 *
 * THE SCHEDULE IS CYCLING, not capped, and that is the requirement rather than
 * an accident — "백오프 한계 넘으면 다시 빠르게". A ladder that settles at five
 * minutes forever handles a busy server and abandons a phone that was in a
 * lift: the network returns and the backup waits out the rest of a five-minute
 * step. Wrapping means every long outage is followed by quick attempts, which
 * is when they are most likely to succeed.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a failure arms another attempt; success stops
 *   累積       → 20 consecutive failures produce 20 attempts — no limit, no
 *                quiet give-up. This is the axis the defect lived on: any
 *                single-call test passes against code that never retries.
 *   累積       → the delays walk the ladder and WRAP, verified across three
 *                full cycles rather than at one boundary
 *   累積       → ten rapid changes leave ONE timer, not ten ladders
 *   contract   → a change during an in-flight upload is not lost
 *   failure    → an upload that THROWS is a failure, not the end of the ladder
 *   boundary   → 'present' (nothing to add) counts as success
 *   integrity  → cancel leaves nothing armed and resets the ladder
 */
import { describe, it, expect } from 'vitest';
import { BackupRetry, nextDelay, RETRY_DELAYS_MS } from '@/lib/mls/backupRetry';

/**
 * A hand-driven clock. Only ONE timer is ever armed by design, so the fake
 * keeps the armed one and `tick()` runs it — a test that drove a queue would
 * hide the very leak the "one timer" case looks for.
 */
function fakeTimers() {
  let armed: { fn: () => void; ms: number } | null = null;
  let created = 0;
  let cleared = 0;
  return {
    get armedMs() {
      return armed?.ms ?? null;
    },
    get created() {
      return created;
    },
    get cleared() {
      return cleared;
    },
    async tick() {
      const t = armed;
      armed = null;
      t?.fn();
      // Let the async upload inside the callback settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    timers: {
      setTimeout(fn: () => void, ms: number) {
        created += 1;
        armed = { fn, ms };
        return created;
      },
      clearTimeout() {
        cleared += 1;
        armed = null;
      },
    },
  };
}

describe('nextDelay — the ladder wraps rather than stopping', () => {
  it('CONTRACT: walks the ladder in order', () => {
    expect(RETRY_DELAYS_MS.map((_, i) => nextDelay(i))).toEqual([...RETRY_DELAYS_MS]);
  });

  it('ACCUMULATING: three full cycles keep wrapping to the fast end', () => {
    /*
     * Checked across cycles, not at one boundary. A modulo written as a clamp
     * (`Math.min(n, last)`) matches at index 0 and at the ceiling and differs
     * everywhere after — so a single-boundary assertion passes the wrong code.
     */
    const len = RETRY_DELAYS_MS.length;
    const seen = Array.from({ length: len * 3 }, (_, i) => nextDelay(i));

    expect(seen).toEqual([...RETRY_DELAYS_MS, ...RETRY_DELAYS_MS, ...RETRY_DELAYS_MS]);
    // The step AFTER the ceiling is the fastest one, not the ceiling again.
    expect(nextDelay(len)).toBe(RETRY_DELAYS_MS[0]);
    expect(nextDelay(len)).toBeLessThan(nextDelay(len - 1));
  });

  it('HOSTILE: nonsense step numbers fall back to the first delay', () => {
    for (const bad of [-1, -100, NaN, Infinity, 0.5]) {
      expect(nextDelay(bad)).toBe(RETRY_DELAYS_MS[0]);
    }
  });
});

describe('BackupRetry — it does not give up', () => {
  it('ACCUMULATING: twenty consecutive failures produce twenty attempts', async () => {
    /*
     * THE CASE THE DEFECT WOULD HAVE FAILED. Code that uploads once and gives
     * up passes every single-call assertion in this file; only counting past
     * the first failure separates "it retries" from "it retried once".
     */
    let calls = 0;
    const clock = fakeTimers();
    const r = new BackupRetry(
      async () => {
        calls += 1;
        return false;
      },
      clock.timers,
    );

    r.schedule();
    for (let i = 0; i < 20; i++) await clock.tick();

    expect(calls).toBe(20);
    expect(clock.armedMs).not.toBeNull(); // still trying
  });

  it('ACCUMULATING: the armed delay walks the ladder and wraps', async () => {
    const clock = fakeTimers();
    const r = new BackupRetry(async () => false, clock.timers);

    r.schedule();
    expect(clock.armedMs).toBe(RETRY_DELAYS_MS[0]);

    const armed: number[] = [];
    for (let i = 0; i < RETRY_DELAYS_MS.length + 2; i++) {
      await clock.tick();
      armed.push(clock.armedMs as number);
    }

    expect(armed.slice(0, RETRY_DELAYS_MS.length)).toEqual([
      ...RETRY_DELAYS_MS.slice(1),
      RETRY_DELAYS_MS[0],
    ]);
    // And having wrapped, it keeps going from the fast end.
    expect(armed[RETRY_DELAYS_MS.length]).toBe(RETRY_DELAYS_MS[1]);
  });

  it('CONTRACT: a success stops the ladder and clears the count', async () => {
    let calls = 0;
    const clock = fakeTimers();
    const r = new BackupRetry(
      async () => ++calls >= 3,
      clock.timers,
    );

    r.schedule();
    await clock.tick();
    await clock.tick();
    await clock.tick();

    expect(calls).toBe(3);
    expect(clock.armedMs).toBeNull();
    expect(r.state).toMatchObject({ attempts: 0, step: 0, armed: false });
  });

  it('BOUNDARY: nothing-to-add counts as success', async () => {
    /*
     * The uploaders answer `present` (the server already holds it) and `empty`
     * (this device has no keys). Both map to `true` at the call sites, and
     * treating either as a failure would retry forever on a healthy phone.
     */
    const clock = fakeTimers();
    const r = new BackupRetry(async () => true, clock.timers);

    r.schedule();
    await clock.tick();

    expect(clock.armedMs).toBeNull();
  });

  it('FAILURE: an upload that throws is a failure, not the end', async () => {
    let calls = 0;
    const clock = fakeTimers();
    const r = new BackupRetry(
      async () => {
        calls += 1;
        throw new Error('network');
      },
      clock.timers,
    );

    r.schedule();
    await clock.tick();
    await clock.tick();

    expect(calls).toBe(2);
    // Two failures = two steps up the ladder, so the THIRD rung is armed.
    expect(clock.armedMs).toBe(RETRY_DELAYS_MS[2]);
  });

  it('ACCUMULATING: ten rapid changes leave ONE armed timer, not ten ladders', async () => {
    /*
     * A device that writes several keys in a second used to schedule an upload
     * per write. Each would fail and each would arm its own retry, so the
     * "backoff" became N ladders climbing together — gentle in the source and a
     * hammer at the server. Counting creates against clears is the only way to
     * see it; the upload count alone looks identical.
     */
    let calls = 0;
    const clock = fakeTimers();
    const r = new BackupRetry(
      async () => {
        calls += 1;
        return false;
      },
      clock.timers,
    );

    for (let i = 0; i < 10; i++) r.schedule();

    /*
     * Measured BEFORE firing: ten schedules must leave one armed timer, which
     * is nine clears against ten creates. Counting after the tick would fold in
     * the retry this failure legitimately arms.
     */
    expect(clock.created).toBe(10);
    expect(clock.cleared).toBe(9);

    await clock.tick();
    expect(calls).toBe(1);
  });

  it('CONTRACT: a change arriving during an upload is not lost', async () => {
    /*
     * Two uploads at once can each read the same server state, and the later
     * write drops what the earlier one added — so a change mid-flight has to be
     * remembered rather than run. Remembering it and never re-arming would be
     * the same data loss with a quieter shape.
     */
    let calls = 0;
    let release: null | (() => void) = null;
    const clock = fakeTimers();
    const r = new BackupRetry(async () => {
      calls += 1;
      await new Promise<void>((res) => {
        release = res as () => void;
      });
      return true;
    }, clock.timers);

    r.schedule();
    await clock.tick(); // upload starts and blocks
    expect(calls).toBe(1);

    // A key is written while the upload is in flight.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).fire();
    (release as null | (() => void))?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The dropped change was re-armed rather than forgotten.
    expect(clock.armedMs).toBe(RETRY_DELAYS_MS[0]);
  });

  it('INTEGRITY: cancel leaves nothing armed and resets the ladder', async () => {
    const clock = fakeTimers();
    const r = new BackupRetry(async () => false, clock.timers);

    r.schedule();
    await clock.tick();
    await clock.tick();
    r.cancel();

    expect(clock.armedMs).toBeNull();
    expect(r.state).toEqual({ attempts: 0, step: 0, armed: false });
  });
});
