/**
 * Telling the server how far the ACCOUNT has read a conversation.
 *
 * The counterpart to `chatDeliveryAck.ts`, and the two answer different
 * questions with the same-shaped data — which is exactly why they are separate
 * files with separate rules rather than one call with a flag:
 *
 *   - DELIVERY is per DEVICE and decides whether the server may drop its only
 *     live copy of a ciphertext. Getting it wrong loses a message.
 *   - READ is per USER and decides whether a badge is drawn. Getting it wrong
 *     shows a wrong number.
 *
 * That asymmetry is what makes their treatment of an UNDECRYPTABLE row
 * OPPOSITE, and it is the single most confusable thing here:
 *
 *   - `chatDeliveryAck.claimable` REFUSES a locked row. Acking it releases
 *     ciphertext this device could not read, and the device waiting for its key
 *     is precisely the one that needed the copy kept.
 *   - this file ACCEPTS one. It was on screen as a locked placeholder — the
 *     user saw it and moved past it. Refusing would strand the badge on a
 *     message they have no way to clear, forever, because no future read can
 *     ever get past a row that will never decrypt.
 *
 * Both are deliberate. Neither is a default. `readMarkOf` therefore does NOT
 * consult `undecryptable`, and a test pins that so nobody "fixes" it into
 * symmetry with the delivery rule.
 *
 * WHAT A FAILURE MAY DO: nothing. By the time this runs the room is on screen
 * and the local cursor has already moved, so the badge is already right for
 * this device. A failed sync costs a stale badge on the user's OTHER devices
 * until the next call, and a thrown one would break the room that had already
 * worked.
 *
 * DEBOUNCED, because the caller is "the room re-rendered". A room scrolling
 * through a burst re-reports its newest row on every message, and one request
 * per message would be one request per message.
 *
 * Two copies exist — `src/lib/chatReadSync.ts` (web) and
 * `packages/mobile/src/lib/chatReadSync.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL. The transport is injected rather than imported for
 * that reason: the browser sends a cookie and the mini-app sends the host's
 * Bearer, and neither belongs in a rule both must apply.
 */

import { isProvisionalId } from './chatStatus';

/** The slice of a message this needs. Both clients' rows carry these. */
export interface ReadableRow {
  createdAt: string;
  /** Server id. A provisional one names a row the server has never seen. */
  id?: string;
  /**
   * Present on web rows, absent on the mini-app's. Declared so the shape is
   * assignable from both — and deliberately NOT read. See the header.
   */
  undecryptable?: boolean;
}

/** A cursor to send: one message, and the instant it was created. */
export interface ReadMark {
  messageId: string;
  readAt: string;
}

/**
 * How long to hold a mark before sending it.
 *
 * Long enough that a burst collapses to one request, short enough that leaving
 * a room does not visibly outrun the write — the user's other device should see
 * the badge clear about as fast as they can pick it up.
 */
export const CHAT_READ_DEBOUNCE_MS = 1_500;

/**
 * The newest row in a batch that may be recorded, or null.
 *
 * Provisional rows are SKIPPED rather than stopping the scan: sending three
 * photos leaves three pending rows on top of real history, and the cursor
 * should still reach the real row underneath them.
 *
 * Compared as INSTANTS, not as strings. The wire format is ISO-8601 UTC and
 * lexical order happens to agree with time order while every row holds that
 * shape — not a property worth depending on. An unparsable timestamp is skipped
 * rather than read as epoch zero, so one bad row cannot drag the mark backwards.
 */
export function readMarkOf(rows: readonly ReadableRow[]): ReadMark | null {
  let mark: ReadMark | null = null;
  let markMs = -Infinity;
  for (const r of rows) {
    const id = r?.id;
    if (typeof id !== 'string' || id === '' || isProvisionalId(id)) continue;
    const ms = Date.parse(r.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > markMs) {
      mark = { messageId: id, readAt: r.createdAt };
      markMs = ms;
    }
  }
  return mark;
}

/** Everything the sync needs, injected so this is testable without a network. */
export interface ChatReadSyncDeps {
  /** PUT the cursor. May reject; the rejection is swallowed. */
  put: (topicId: string, mark: ReadMark) => Promise<unknown>;
  /** Overridable only for tests. Defaults to the ambient timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingTopic {
  /** The newest mark seen since the last successful send. */
  mark: ReadMark;
  markMs: number;
  timer: unknown;
  deps: ChatReadSyncDeps;
}

const pending = new Map<string, PendingTopic>();
/** Instant of the newest mark already SENT per topic, to skip no-op requests. */
const sentMs = new Map<string, number>();
/** Topics with a request in flight, so a second does not race the first. */
const inFlight = new Set<string>();

function timers(deps: ChatReadSyncDeps) {
  const set = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return { set, clear };
}

/**
 * Record that `rows` have been read in `topicId`, eventually.
 *
 * Returns immediately — the caller is a render effect. Coalescing rule: the
 * pending mark for a topic is replaced whenever a NEWER one arrives, so a
 * window that sees a hundred marks sends the hundredth, not the first. That is
 * the property worth stating precisely, because the naive debounce (drop
 * everything that arrives while a timer is running) sends the FIRST and loses
 * the final write — which would leave the badge one burst behind on every other
 * device, exactly the bug this whole path exists to fix.
 *
 * The timer is NOT restarted on each call. A room receiving a message every
 * 200 ms would otherwise push the deadline out forever and never write at all.
 */
export function scheduleChatReadSync(
  topicId: unknown,
  rows: readonly ReadableRow[],
  deps: ChatReadSyncDeps,
): void {
  if (typeof topicId !== 'string' || topicId.trim() === '') return;
  const key = topicId.trim();
  const mark = readMarkOf(rows);
  if (mark === null) return;
  const markMs = Date.parse(mark.readAt);
  if (!Number.isFinite(markMs)) return;

  // Already told the server about this instant or a later one.
  const sent = sentMs.get(key);
  if (sent !== undefined && markMs <= sent) return;

  const existing = pending.get(key);
  if (existing) {
    // Newer wins; older is dropped. Never restart the timer — see above.
    if (markMs > existing.markMs) {
      existing.mark = mark;
      existing.markMs = markMs;
      existing.deps = deps;
    }
    return;
  }

  const { set } = timers(deps);
  const entry: PendingTopic = { mark, markMs, timer: undefined, deps };
  pending.set(key, entry);
  entry.timer = set(() => {
    void send(key);
  }, CHAT_READ_DEBOUNCE_MS);
}

/**
 * Send whatever is pending for one topic. Never rejects.
 *
 * A failure leaves the mark PENDING rather than dropping it, so the next
 * schedule for that topic retries it instead of the room having to receive
 * another message before the server hears anything.
 */
async function send(key: string, reArm = true): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  if (inFlight.has(key)) {
    // A previous request has not finished. Re-arm rather than racing it: two
    // writes for one account are already handled by the server's GREATEST, but
    // firing both wastes the request and can deliver them out of order.
    if (!reArm) return;
    const { set } = timers(entry.deps);
    entry.timer = set(() => {
      void send(key);
    }, CHAT_READ_DEBOUNCE_MS);
    return;
  }
  const { mark, markMs, deps } = entry;
  pending.delete(key);
  inFlight.add(key);
  try {
    await deps.put(key, mark);
    const sent = sentMs.get(key);
    if (sent === undefined || markMs > sent) sentMs.set(key, markMs);
  } catch {
    // Silent by contract. Put the mark back unless something newer already
    // took its place while the request was out.
    const now = pending.get(key);
    if (!now && reArm) {
      const { set } = timers(deps);
      const retry: PendingTopic = { mark, markMs, timer: undefined, deps };
      pending.set(key, retry);
      retry.timer = set(() => {
        void send(key);
      }, CHAT_READ_DEBOUNCE_MS);
    }
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Send a topic's pending mark now instead of waiting out the debounce, or every
 * topic's when called with no argument. Never rejects.
 *
 * `reArm` false means "and then stop" — one last attempt, no retry timer left
 * behind. That is what CLOSING a room wants: a background retry loop for a
 * conversation nobody is looking at buys nothing (the next visit re-reports the
 * same mark) and costs a live timer that outlives the component. In a test
 * process the same timer outlives the TEST, firing a request into the next
 * one's fetch stub — which is how this switch was found.
 */
export async function flushChatReadSync(topicId?: string, reArm = true): Promise<void> {
  const keys = typeof topicId === 'string' ? [topicId.trim()] : [...pending.keys()];
  await Promise.all(
    keys.map((key) => {
      const entry = pending.get(key);
      if (!entry) return Promise.resolve();
      const { clear } = timers(entry.deps);
      clear(entry.timer);
      return send(key, reArm);
    }),
  );
}

/**
 * The room is closing: flush once, retry never, leave no timer.
 *
 * Its own name rather than a boolean at the call site, because the call site is
 * a `useEffect` cleanup and "what happens to a failed write here" is the whole
 * question a reader of that line will have.
 */
export function endChatReadSync(topicId: string): void {
  void flushChatReadSync(topicId, false);
}

/** Test seam: forget every pending mark, timer and sent instant. */
export function resetChatReadSync(): void {
  for (const entry of pending.values()) {
    const { clear } = timers(entry.deps);
    clear(entry.timer);
  }
  pending.clear();
  sentMs.clear();
  inFlight.clear();
}
