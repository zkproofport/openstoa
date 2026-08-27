/**
 * "아직 메시지가 없어요" MAY ONLY BE SAID AFTER A FETCH THAT SUCCEEDED.
 *
 * On a phone on 2026-08-27 the room said it about a room holding two messages,
 * while the banner underneath said the session had ended. The list was empty
 * because the fetch was refused; the screen reported it as an empty history.
 *
 * The check is the WHOLE matrix, not one case. The defect was never one
 * combination being wrong — it was one sentence covering every combination, so
 * a test that picked a single state would have passed against the broken code
 * as easily as against the fixed one.
 */
import { describe, expect, it } from 'vitest';

import {
  chatEmptyLabelKey,
  chatEmptyReason,
  type HistoryStatus,
} from '../lib/chatEmptyState';

const HISTORY: HistoryStatus[] = ['pending', 'error', 'success'];
// Every state the chat stream reports, plus one it does not, because an
// unfamiliar value must not be read as "all is well".
const STREAM = ['open', 'connecting', 'closed', 'rejected', 'something-new'];

const EMPTY_LINE = 'openstoa.chat.noMessagesYet';

describe('an empty room says why', () => {
  it('claims the history is empty only where the fetch actually succeeded', () => {
    const claimed: string[] = [];
    for (const historyStatus of HISTORY) {
      for (const streamStatus of STREAM) {
        const key = chatEmptyLabelKey(chatEmptyReason({ historyStatus, streamStatus }));
        if (key === EMPTY_LINE) claimed.push(`${historyStatus}/${streamStatus}`);
      }
    }
    // Success + a stream that has not been refused. Nothing else.
    expect(claimed.sort()).toEqual(
      [
        'success/closed',
        'success/connecting',
        'success/open',
        'success/something-new',
      ].sort(),
    );
  });

  it('never says the history is empty while a fetch is in flight or has failed', () => {
    for (const streamStatus of STREAM) {
      expect(chatEmptyLabelKey(chatEmptyReason({ historyStatus: 'pending', streamStatus })))
        .not.toBe(EMPTY_LINE);
      expect(chatEmptyLabelKey(chatEmptyReason({ historyStatus: 'error', streamStatus })))
        .not.toBe(EMPTY_LINE);
    }
  });

  it('says nothing at all while the first page is still loading', () => {
    expect(chatEmptyLabelKey(chatEmptyReason({ historyStatus: 'pending', streamStatus: 'open' })))
      .toBeNull();
  });

  it('names the refused session ahead of the fetch failure it caused', () => {
    // A refusal usually fails the fetch too. The person can act on "sign in
    // again"; they can do nothing with "could not load".
    expect(chatEmptyReason({ historyStatus: 'error', streamStatus: 'rejected' }))
      .toBe('signed-out');
  });

  it('every reason has a line, or a deliberate silence', () => {
    const reasons = ['loading', 'signed-out', 'load-failed', 'empty'] as const;
    const keys = reasons.map((r) => chatEmptyLabelKey(r));
    expect(keys).toEqual([
      null,
      'openstoa.chat.historySignedOut',
      'openstoa.chat.historyUnavailable',
      EMPTY_LINE,
    ]);
  });
});
