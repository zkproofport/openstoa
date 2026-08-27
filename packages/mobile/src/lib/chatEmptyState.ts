/**
 * WHY THE EMPTY ROOM NEEDS A REASON.
 *
 * The room rendered `아직 메시지가 없어요` under every empty list — including
 * the list that is empty because the fetch failed. Seen on a phone on
 * 2026-08-27: the same screen said "no messages yet" in the middle and
 * "please sign in again" at the bottom, about a room that held two.
 *
 * In an end-to-end encrypted app "your history is empty" is the most
 * frightening sentence there is, and it is the one sentence we are least
 * entitled to say — the device that cannot fetch, or cannot decrypt, knows
 * nothing about whether messages exist. Saying it anyway turns a signed-out
 * session into an apparent data loss.
 *
 * Extracted from the JSX so the decision can be tested. A ternary inside a
 * `ListEmptyComponent` cannot be, which is how it survived this long.
 */

/** What an empty message list actually means right now. */
export type ChatEmptyReason = 'loading' | 'signed-out' | 'load-failed' | 'empty';

/** The state of the history fetch, as react-query reports it. */
export type HistoryStatus = 'pending' | 'error' | 'success';

export interface ChatEmptyInput {
  historyStatus: HistoryStatus;
  /** The live stream's state. `rejected` means the server refused this session. */
  streamStatus: string;
}

/**
 * Why the list is empty.
 *
 * Ordered by what the person can act on. A refused session is the most
 * specific and most actionable, so it wins over a generic fetch failure that
 * it probably caused; a fetch still in flight is not a failure; and only when
 * a fetch has actually SUCCEEDED and returned nothing may we say the room is
 * empty.
 */
export function chatEmptyReason({ historyStatus, streamStatus }: ChatEmptyInput): ChatEmptyReason {
  if (streamStatus === 'rejected') return 'signed-out';
  if (historyStatus === 'error') return 'load-failed';
  if (historyStatus === 'pending') return 'loading';
  return 'empty';
}

/**
 * The line to show, or null while a fetch is still in flight.
 *
 * Loading gets no sentence at all rather than a hedged one — the list is
 * about to fill, and a message that appears for 200ms and is replaced reads
 * as a flicker, not as information.
 */
export function chatEmptyLabelKey(reason: ChatEmptyReason): string | null {
  switch (reason) {
    case 'loading':
      return null;
    case 'signed-out':
      return 'openstoa.chat.historySignedOut';
    case 'load-failed':
      return 'openstoa.chat.historyUnavailable';
    case 'empty':
      return 'openstoa.chat.noMessagesYet';
  }
}
