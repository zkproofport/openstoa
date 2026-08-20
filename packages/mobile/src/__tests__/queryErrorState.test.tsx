/**
 * A list that failed to load says so, and never poses as an empty list.
 *
 * Eleven screens had no error branch at all. Because every one of them defaults
 * its data to `[]`, a failed fetch rendered the empty state instead: the Topics
 * tab in aeroplane mode said "No topics found". That is worse than a silent
 * failure — it is a confident false statement, and it invites someone to stop
 * looking. Three chat screens DID have an error state, hand-rolled three times.
 *
 * So the fix is one component, used by all of them, and the two assertions that
 * matter are: the failure is stated, and the empty state does not appear in its
 * place.
 *
 * Presentation is deliberately NOT the modal used for a failed action. A load
 * failure leaves nothing on screen, so a modal would be wrong twice: dismissing
 * it reveals a blank page, and the one control that matters — try again — would
 * be dismissed with it. That split is asserted in `failureReporting.test.ts` on
 * the action side; here it is the inline side.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → the title, the reason and a working Retry all render
 *   integrity  → the reason shown is the error's own sentence, and carries no
 *                endpoint (the leak this pairs with)
 *   hostile    → a thrown non-Error, and an Error with an empty message, still
 *                produce a readable line instead of "[object Object]" or blank
 *   empty      → a whitespace-only message falls back rather than rendering air
 *   boundary   → Retry fires exactly once per press, and again on a second
 *                press — a disabled-after-first-try button would strand people
 *   UTF-8      → a Korean server sentence survives
 *   authz / very large / race → N/A: a presentational component with no caller
 *                identity, no async state and no input it does not receive.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from './harness/render';
import { QueryErrorState } from '../components/QueryErrorState';
import { OpenStoaApiError, OpenStoaNetworkError } from '../api/openstoaClient';

const TITLE = 'openstoa.common.loadFailed.topics';

describe('QueryErrorState', () => {
  it('CONTRACT: states what failed, why, and offers a way to try again', async () => {
    const r = await render(
      <QueryErrorState
        title={TITLE}
        error={new OpenStoaNetworkError('/api/topics', new TypeError('Network request failed'))}
        onRetry={() => {}}
      />,
    );

    expect(r.text()).toContain(TITLE);
    expect(r.text()).toContain('Could not reach the server');
    expect(r.root.findAll((n) => n.props?.testID === 'query-error-retry').length).toBeGreaterThan(0);
  });

  it('INTEGRITY: the reason names no endpoint', async () => {
    // Pairs with the client-side fix: `message` is a sentence, the path is a
    // field. A component that reached for the path would undo that.
    const r = await render(
      <QueryErrorState
        title={TITLE}
        error={new OpenStoaNetworkError('/api/topics', new Error('x'))}
        onRetry={() => {}}
      />,
    );

    expect(r.text()).not.toContain('/api/');
  });

  it('INTEGRITY: a server refusal shows the server’s own words', async () => {
    const r = await render(
      <QueryErrorState
        title={TITLE}
        error={new OpenStoaApiError(403, '/api/topics', 'You are not a member.', 'GET … → 403')}
        onRetry={() => {}}
      />,
    );

    expect(r.text()).toContain('You are not a member.');
    expect(r.text()).not.toContain('403');
  });

  it('UTF-8: a Korean sentence survives', async () => {
    const korean = '이 토픽에 접근할 수 없어요.';
    const r = await render(
      <QueryErrorState
        title={TITLE}
        error={new OpenStoaApiError(403, '/api/topics', korean, 'GET … → 403')}
        onRetry={() => {}}
      />,
    );

    expect(r.text()).toContain(korean);
  });

  it.each([
    ['a thrown string', 'boom' as unknown],
    ['a thrown object', { nope: true } as unknown],
    ['null', null as unknown],
    ['an Error with an empty message', new Error('')],
    ['an Error with only whitespace', new Error('   ')],
  ])('HOSTILE/EMPTY: %s still renders a readable line', async (_label, thrown) => {
    const r = await render(<QueryErrorState title={TITLE} error={thrown} onRetry={() => {}} />);

    const text = r.text();
    expect(text).toContain(TITLE);
    expect(text).toContain('openstoa.common.errorFallback');
    expect(text).not.toContain('[object Object]');
  });

  it('BOUNDARY: Retry fires once per press, and stays pressable', async () => {
    // A retry that only works once would strand someone whose connection comes
    // back a moment later.
    let presses = 0;
    const r = await render(
      <QueryErrorState title={TITLE} error={new Error('nope')} onRetry={() => { presses += 1; }} />,
    );
    const button = () => r.root.findAll((n) => n.props?.testID === 'query-error-retry')[0];

    await r.press(button());
    expect(presses).toBe(1);
    await r.press(button());
    expect(presses).toBe(2);
  });
});
