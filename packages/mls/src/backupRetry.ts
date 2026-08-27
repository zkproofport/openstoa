/**
 * Keep trying to put the TAK keychain on the server until it is there.
 *
 * WHY THIS EXISTS. The upload was fired once, debounced 1.5s after a keychain
 * write, and on failure the code said — in a comment — "retried on the next
 * keychain change". For an active user that is nearly true. For the user this
 * feature is FOR it is false: somebody who reads more than they write may not
 * touch a key for weeks, so one failed upload meant no backup at all, and the
 * recovery code they were handed would come back and open nothing. The failure
 * was silent on both sides — the phone logged a warning nobody reads, and the
 * server simply had no row.
 *
 * THE SHAPE THE USER ASKED FOR, verbatim: "리트라이 계속 해야하고 백오프 한계
 * 넘으면 다시 빠르게". So the delay grows, and when it reaches the ceiling it
 * goes back to the start rather than staying there. That is deliberate and it
 * is not the usual capped backoff:
 *
 *   - Growing matters because the common failure is a server or a network that
 *     needs a moment, and hammering it helps nobody.
 *   - CYCLING matters because the other common failure is a phone that was in
 *     a lift, on a plane, or asleep. A schedule that settles at five minutes
 *     forever answers the first case and abandons the second — the network came
 *     back thirty seconds ago and the backup waits four and a half minutes to
 *     notice. Cycling means every long outage is followed promptly by a burst
 *     of quick attempts, which is exactly when they are most likely to work.
 *
 * There is no attempt limit. A missing backup does not become acceptable after
 * twenty tries; it becomes more urgent.
 *
 * PURE ON PURPOSE. `nextDelay` is arithmetic over a step number so it can be
 * tested for the whole cycle without a clock, and the scheduler takes its
 * timer functions as arguments so a test can drive weeks of retries in
 * milliseconds. The bug this replaces was invisible precisely because the old
 * code could only be observed by waiting.
 */

/**
 * The ladder, in milliseconds. Starts at the debounce the upload already used,
 * so the first attempt after a keychain write is unchanged from before.
 */
export const RETRY_DELAYS_MS = [1_500, 5_000, 15_000, 60_000, 300_000] as const;

/**
 * Delay before attempt number `step` (0-based, counting only FAILURES so far).
 *
 * Past the end of the ladder it wraps to the beginning — the ceiling is a turn,
 * not a stop. See the header for why.
 */
export function nextDelay(step: number): number {
  const n = Number.isFinite(step) && step > 0 ? Math.floor(step) : 0;
  return RETRY_DELAYS_MS[n % RETRY_DELAYS_MS.length];
}

export interface RetryTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * `true` means the server now holds this device's keys — including the case
 * where it already did, and the case where there were none to send.
 *
 * A BOOLEAN rather than the uploader's own vocabulary, and deliberately so:
 * the mobile uploader answers with five words and the web one with three, and
 * the mapping between them and "is it backed up" is a judgement each caller
 * has to make out loud. Importing one of those enums here would quietly make
 * this file the place that decides whether `untrusted` counts as done.
 */
export type UploadOutcome = boolean;

/**
 * One upload, retried until it lands.
 *
 * ONE TIMER, ALWAYS. Every entry point cancels the pending one first. Without
 * that, a device that writes ten keys in a second schedules ten uploads that
 * each fail and each schedule their own retry, and the ladder becomes ten
 * ladders climbing in parallel — which looks like backoff in the code and like
 * a hammer on the server.
 */
export class BackupRetry {
  private handle: unknown = null;
  private step = 0;
  /** Attempts made since the last success. Reported, never used as a limit. */
  private attempts = 0;
  private running = false;
  /** A change that arrived while an upload was in flight. */
  private pending = false;

  constructor(
    private readonly upload: () => Promise<UploadOutcome>,
    private readonly timers: RetryTimers,
    private readonly onEvent: (e: RetryEvent) => void = () => {},
  ) {}

  /**
   * The keychain changed, or a session was established. Restarts the ladder at
   * the fast end: new keys are the case most worth uploading promptly, and a
   * device that has been failing for an hour should not make the person wait
   * out a five-minute step before trying with the key they just got.
   */
  schedule(): void {
    this.step = 0;
    this.arm(nextDelay(0));
  }

  /** Stop retrying — sign-out, or an erase. Leaves nothing armed. */
  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
    this.step = 0;
    this.attempts = 0;
    this.pending = false;
  }

  /** For reporting and for tests. */
  get state(): { attempts: number; step: number; armed: boolean } {
    return { attempts: this.attempts, step: this.step, armed: this.handle !== null };
  }

  private arm(ms: number): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.fire();
    }, ms);
  }

  private async fire(): Promise<void> {
    /*
     * Never two uploads at once. The upload merges the local keychain into
     * whatever the server holds, so two in flight can each read the same server
     * state and the later write can drop what the earlier one added. The change
     * that arrived meanwhile is not lost — it is remembered and re-armed below.
     */
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.attempts += 1;

    let landed: boolean;
    try {
      landed = await this.upload();
    } catch {
      // A thrown upload is a failed upload. The distinction would only change
      // the log line, and treating it as anything else would end the ladder.
      landed = false;
    } finally {
      this.running = false;
    }

    if (!landed) {
      this.step += 1;
      const ms = nextDelay(this.step);
      this.onEvent({ kind: 'retry', attempts: this.attempts, delayMs: ms });
      this.arm(ms);
      return;
    }

    this.onEvent({ kind: 'ok', attempts: this.attempts });
    this.step = 0;
    this.attempts = 0;
    if (this.pending) {
      this.pending = false;
      this.schedule();
    }
  }
}

export type RetryEvent =
  | { kind: 'retry'; attempts: number; delayMs: number }
  | { kind: 'ok'; attempts: number };
