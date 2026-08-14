/**
 * Telling the server what this device has actually received.
 *
 * The other half of `chatDeliveryPurge.ts`. The server drops a message's live
 * ciphertext once every device that was in the group at send time has fetched
 * it — so without this call the purge is inert and every client pins its own
 * ciphertext until the 30-day grace cap.
 *
 * It lives in its own module rather than inside the chat panel for two reasons.
 * The rules below are worth testing on their own (what may be claimed, and what
 * a failure is allowed to do), and the call site inside a 2 000-line chat
 * component should be one line, in a file two people are not editing at once.
 *
 * WHAT MAY BE CLAIMED. Only messages this device has actually processed. The
 * mark is what releases the server's only live copy, so acking optimistically —
 * on receipt rather than after the decrypt pass — trades a message for a round
 * trip. The caller passes the rows it has in hand and this takes the newest.
 *
 * WHAT A FAILURE MAY DO: nothing. By the time this runs the messages are on
 * screen. A failed acknowledgement costs some server storage until the next
 * pass; a thrown one would break the read that already succeeded.
 *
 * Two copies exist — `src/lib/chatDeliveryAck.ts` (web) and
 * `packages/mobile/src/lib/chatDeliveryAck.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL. The transport is injected rather than imported for
 * exactly that reason: the browser posts with a cookie and the mini-app posts
 * through its own client, and neither belongs in a rule both must apply.
 */

import { isProvisionalId } from './chatStatus';

/** The minimum shape needed to pick a mark. Callers carry the full message. */
export interface AckableMessage {
  createdAt: string;
  /** Server id. A provisional one names a row the server has never seen. */
  id?: string;
  /** True when this device could not read the body — see `claimable`. */
  undecryptable?: boolean;
}

/**
 * May this row be claimed as delivered?
 *
 * Two rows must never be, and both arrive in the same array as good ones:
 *
 *  - **Undecryptable.** A failed decrypt degrades to `{ message: '',
 *    undecryptable: true }` rather than throwing, so a locked row travels
 *    beside readable ones. Acking it tells the server "delivered" for
 *    ciphertext this device could not read — and the purge then drops the only
 *    copy. A device waiting for its key is precisely the device that needs that
 *    copy to survive, so this is the case where the mistake costs the most.
 *  - **Provisional.** An optimistic send, and a restored failed attachment,
 *    carry a locally-minted id (`isProvisionalId`) for a row the server has
 *    never seen. A restored attachment also carries the FAILED SEND's
 *    `createdAt`, which can be hours old and is client-supplied — claiming it
 *    would be claiming an instant on behalf of a message that never went out.
 *
 * Both were caught in review rather than by a test, which is the argument for
 * putting the rule here instead of at each call site: a filter written into a
 * chat component is one someone re-adds a path around.
 */
export function claimable(m: AckableMessage): boolean {
  if (m.undecryptable) return false;
  if (typeof m.id === 'string' && isProvisionalId(m.id)) return false;
  return true;
}

/**
 * The instant to claim for a batch of rows, or null when there is nothing to
 * claim.
 *
 * Null for an empty batch rather than "now": a room with no messages has no
 * delivery to acknowledge, and claiming the current instant would release
 * anything that lands in the same millisecond.
 *
 * Compared as INSTANTS, not as strings. The wire format is ISO-8601 UTC today
 * and lexical order happens to agree with time order while that holds for every
 * row — which is not a property worth depending on. Unparsable timestamps are
 * skipped rather than treated as epoch zero, so one bad row cannot drag the
 * mark backwards.
 */
export function deliveryMarkOf(messages: readonly AckableMessage[]): string | null {
  let mark: string | null = null;
  let markMs = -Infinity;
  for (const m of messages) {
    if (!claimable(m)) continue;
    const ms = Date.parse(m.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > markMs) {
      mark = m.createdAt;
      markMs = ms;
    }
  }
  return mark;
}

/** Everything the ack needs, injected so this is testable without a browser. */
export interface AckDeliveryDeps {
  /** This device's MLS leaf id. */
  deviceId: () => Promise<string>;
  post: (topicId: string, deviceId: string, through: string) => Promise<void>;
}

/**
 * Acknowledge a batch of rows for a topic. Resolves to the mark that was sent,
 * or null when nothing was claimed.
 *
 * Never rejects. Every failure path — no rows, no device id, a refused request
 * — resolves null, because the caller is a chat panel that has already
 * rendered the messages and has nothing useful to do with an error here.
 */
export async function ackDelivery(
  topicId: string,
  messages: readonly AckableMessage[],
  deps: AckDeliveryDeps,
): Promise<string | null> {
  const through = deliveryMarkOf(messages);
  if (through === null) return null;
  try {
    const deviceId = await deps.deviceId();
    if (!deviceId) return null;
    await deps.post(topicId, deviceId, through);
    return through;
  } catch {
    return null;
  }
}
