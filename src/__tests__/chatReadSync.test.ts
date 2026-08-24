/**
 * The client-side half of the read cursor: what may be recorded, how a burst
 * collapses into one request, and that nothing here can break a room.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   boundary        → empty batch, one row, a batch whose newest is provisional
 *   hostile         → `pending-` ids, unparsable timestamps, a mark already sent
 *   empty/null      → empty topic id, whitespace topic id, empty rows
 *   race            → the debounce keeps the FINAL mark, not the first; a mark
 *                     arriving mid-flight is not lost; a rejected PUT is
 *                     retried rather than dropped
 *   contract        → an UNDECRYPTABLE row advances the cursor. This is the
 *                     opposite of `chatDeliveryAck.claimable` and the one rule
 *                     most likely to be "fixed" into symmetry, so it is pinned
 *                     explicitly rather than left implicit in the code
 *   result integrity→ the mark sent is the NEWEST readable row by instant, not
 *                     the last element of the array
 *   UTF-8 / large / authz → N/A: this module transports two opaque strings and
 *                     performs no I/O of its own; authorization is the route's
 *                     and is covered in `src/__tests__/e2e/chat-read.test.ts`
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readMarkOf,
  scheduleChatReadSync,
  flushChatReadSync,
  endChatReadSync,
  resetChatReadSync,
  CHAT_READ_DEBOUNCE_MS,
  type ReadMark,
} from '@/lib/chatReadSync';

const TOPIC = 'e3b0c442-98fc-1c14-9afb-f4c8996fb924';
const at = (n: number) => new Date(Date.UTC(2026, 7, 24, 0, 0, n)).toISOString();
const row = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt: at(n),
  ...extra,
});

/**
 * A controllable timer, so the debounce can be tested without waiting.
 *
 * Hand-rolled rather than `vi.useFakeTimers()` because the module resolves its
 * timer functions through injected deps for exactly this reason — and because a
 * fake-timer test would still pass if the module quietly stopped using the
 * injected ones, which is the mistake worth catching.
 */
function fakeTimers() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      expect(ms).toBe(CHAT_READ_DEBOUNCE_MS);
      const handle = next++;
      queue.set(handle, fn);
      return handle;
    },
    clearTimer: (h: unknown) => {
      queue.delete(h as number);
    },
    /** Fire everything currently queued. */
    run: () => {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    pending: () => queue.size,
  };
}

beforeEach(() => {
  resetChatReadSync();
});

describe('readMarkOf — which row may be recorded', () => {
  it('takes the newest readable row by INSTANT, not the last element', () => {
    // Deliberately out of order: a delta-sync merge or a history page can put
    // an older row last, and taking `at(-1)` would record it.
    expect(readMarkOf([row('m3', 30), row('m1', 10), row('m2', 20)])).toEqual({
      messageId: 'm3',
      readAt: at(30),
    });
  });

  it('returns null for an empty batch rather than "now"', () => {
    expect(readMarkOf([])).toBeNull();
  });

  it('steps OVER provisional rows to the real row underneath', () => {
    // Sending three photos leaves three pending rows on top of real history.
    const rows = [
      row('m1', 10),
      { id: 'pending-000000000001', createdAt: at(90) },
      { id: 'pending-000000000002', createdAt: at(91) },
    ];
    expect(readMarkOf(rows)).toEqual({ messageId: 'm1', readAt: at(10) });
  });

  it('returns null when every row is provisional or malformed', () => {
    expect(readMarkOf([{ id: 'pending-000000000001', createdAt: at(90) }])).toBeNull();
    expect(readMarkOf([{ id: '', createdAt: at(10) }])).toBeNull();
    expect(readMarkOf([{ createdAt: at(10) }])).toBeNull();
    expect(readMarkOf([{ id: 'm1', createdAt: 'not-a-date' }])).toBeNull();
  });

  it('skips an unparsable timestamp instead of reading it as epoch zero', () => {
    // One bad row must not become the mark, and must not drag the mark back.
    expect(readMarkOf([row('m2', 20), { id: 'bad', createdAt: 'nonsense' }])).toEqual({
      messageId: 'm2',
      readAt: at(20),
    });
  });

  it('ADVANCES on an undecryptable row — the opposite of the delivery ack', () => {
    /*
     * The rule this repo is most likely to "correct" into symmetry with
     * `chatDeliveryAck.claimable`, which refuses a locked row. Refusing here
     * would strand the badge on a message that can never decrypt, so no future
     * read could ever clear it. Pinned as behaviour, not as a comment.
     */
    const rows = [row('m1', 10), row('m2', 20, { undecryptable: true })];
    expect(readMarkOf(rows)).toEqual({ messageId: 'm2', readAt: at(20) });
  });
});

describe('scheduleChatReadSync — the debounce', () => {
  it('collapses a burst into ONE request carrying the FINAL mark', async () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    for (let n = 1; n <= 20; n++) {
      scheduleChatReadSync(TOPIC, [row(`m${n}`, n)], { put, ...timers });
    }
    expect(put, 'nothing may go out before the window closes').not.toHaveBeenCalled();
    timers.run();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
    // The naive debounce sends the FIRST mark and loses the final write, which
    // would leave every other device one burst behind.
    expect(put.mock.calls[0][1]).toEqual({ messageId: 'm20', readAt: at(20) });
  });

  it('does not restart the timer on each call, so a busy room still writes', () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m1', 1)], { put, ...timers });
    scheduleChatReadSync(TOPIC, [row('m2', 2)], { put, ...timers });
    scheduleChatReadSync(TOPIC, [row('m3', 3)], { put, ...timers });
    // One timer, not three, and not a fresh one pushing the deadline out.
    expect(timers.pending()).toBe(1);
  });

  it('skips a mark at or behind one already sent', async () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m5', 50)], { put, ...timers });
    timers.run();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);

    // An older `?before=` history page landing afterwards.
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync(TOPIC, [row('m5', 50)], { put, ...timers });
    expect(timers.pending(), 'neither should have armed a request').toBe(0);
    timers.run();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('keeps topics separate', async () => {
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync(other, [row('n1', 10)], { put, ...timers });
    timers.run();
    await Promise.resolve();
    expect(put.mock.calls.map((c) => c[0]).sort()).toEqual([other, TOPIC].sort());
  });

  it('records nothing for an empty / whitespace topic id, or an unusable batch', () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync('', [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync('   ', [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync(undefined, [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync(TOPIC, [], { put, ...timers });
    scheduleChatReadSync(TOPIC, [{ id: 'pending-000000000001', createdAt: at(9) }], { put, ...timers });
    expect(timers.pending()).toBe(0);
    timers.run();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('failure is silent, and the mark is not lost', () => {
  it('never rejects when the transport does', async () => {
    const timers = fakeTimers();
    const put = vi.fn().mockRejectedValue(new Error('offline'));
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    // By the time this runs the messages are on screen; a throw here would
    // break a read that already succeeded.
    expect(() => timers.run()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('re-arms a failed mark instead of dropping it', async () => {
    const timers = fakeTimers();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    timers.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending(), 'a failed write must be retried, not forgotten').toBe(1);
    timers.run();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1]).toEqual({ messageId: 'm1', readAt: at(10) });
  });

  it('does not resurrect an older mark over a newer one that arrived meanwhile', async () => {
    const timers = fakeTimers();
    const rejects: Array<(e: Error) => void> = [];
    const put = vi.fn().mockImplementation(
      () => new Promise<void>((_, reject) => { rejects.push(reject); }),
    );
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    timers.run(); // request out, still pending
    scheduleChatReadSync(TOPIC, [row('m9', 90)], { put, ...timers });
    rejects.forEach((reject) => reject(new Error('offline')));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    timers.run();
    await Promise.resolve();
    // The retry must not overwrite the newer pending mark with the failed one.
    const sent = put.mock.calls.map((c) => (c[1] as ReadMark).messageId);
    expect(sent[sent.length - 1]).toBe('m9');
  });
});

describe('flushChatReadSync — leaving the room', () => {
  it('sends the pending mark immediately instead of waiting out the window', async () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    expect(put).not.toHaveBeenCalled();
    await flushChatReadSync(TOPIC);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toEqual({ messageId: 'm1', readAt: at(10) });
  });

  it('flushes every topic when called with no argument, and is a no-op when idle', async () => {
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    scheduleChatReadSync(other, [row('n1', 10)], { put, ...timers });
    await flushChatReadSync();
    expect(put).toHaveBeenCalledTimes(2);
    await expect(flushChatReadSync()).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('endChatReadSync — the room is closing', () => {
  it('sends the pending mark and leaves NO timer, even when the write fails', async () => {
    /*
     * A retry loop for a room nobody is looking at buys nothing — the next
     * visit re-reports the same mark — and costs a live timer that outlives the
     * component. In a test process it outlives the TEST too, firing a request
     * into the next one's fetch stub; that is how this path was found, as a
     * ChatPanel suite that went red for a reason nothing in it was doing.
     */
    const timers = fakeTimers();
    const put = vi.fn().mockRejectedValue(new Error('offline'));
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    endChatReadSync(TOPIC);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(put, 'the last write is still attempted').toHaveBeenCalledTimes(1);
    expect(timers.pending(), 'and nothing is left ticking').toBe(0);
  });

  it('still re-arms on the ordinary path, so a failed write mid-room is retried', async () => {
    // The contrast that makes the switch meaningful rather than a blanket
    // "stop retrying".
    const timers = fakeTimers();
    const put = vi.fn().mockRejectedValue(new Error('offline'));
    scheduleChatReadSync(TOPIC, [row('m1', 10)], { put, ...timers });
    await flushChatReadSync(TOPIC);
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending()).toBe(1);
  });

  it('is a no-op for a topic with nothing pending', async () => {
    const timers = fakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    expect(() => endChatReadSync(TOPIC)).not.toThrow();
    await Promise.resolve();
    expect(put).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients record the same mark', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const web = readFileSync(join(process.cwd(), 'src/lib/chatReadSync.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatReadSync.ts'), 'utf8');
    expect(mobile).toBe(web);
  });

  it("carries no transport, so neither client can import the other's", async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/lib/chatReadSync.ts', 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('credentials');
  });
});
