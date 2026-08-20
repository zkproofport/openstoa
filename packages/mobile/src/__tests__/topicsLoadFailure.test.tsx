/**
 * The Topics tab does not claim there are no topics when it could not ask.
 *
 * This is the defect, mounted. `topicsQuery` defaults to `[]` on failure, the
 * FlatList saw an empty array, and `ListEmptyComponent` rendered "No topics
 * found" — so a phone in aeroplane mode was told, in plain words, that the
 * community was empty. Not a missing error message: a false one, and the kind
 * that makes someone stop opening the tab.
 *
 * Asserted at the screen rather than on the component, because the bug was
 * never in the error UI — it was in which branch the screen chose. A unit test
 * of `QueryErrorState` passes happily while the screen never renders it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a failed load renders the error state
 *   integrity  → and specifically NOT the empty state; the two are mutually
 *                exclusive, in both directions
 *   boundary   → a genuinely empty (but successful) response still shows the
 *                empty state, so this fix cannot swallow the real empty case
 *   external   → the failure exercised is an unreachable server, which is what
 *                aeroplane mode produces
 *   hostile / UTF-8 / very large / authz / race → N/A: the screen is choosing
 *                between two branches on one boolean; the inputs to that
 *                boolean belong to react-query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import { TopicsHomeScreen } from '../screens/topics/TopicsHomeScreen';

const ERROR_TITLE = 'openstoa.common.loadFailed.topics';

/** Answers `/api/topics` with `mode`, and everything else with an empty list. */
function fetchWith(mode: 'offline' | 'empty') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/topics')) {
      if (mode === 'offline') throw new TypeError('Network request failed');
      return {
        ok: true,
        status: 200,
        json: async () => ({ topics: [] }),
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ categories: [] }),
      text: async () => '',
    } as unknown as Response;
  });
}

/**
 * Wait until the screen actually shows something, rather than for a fixed
 * number of microtask drains.
 *
 * A rejection travels through more turns than a resolution, and how many is not
 * fixed — it depends on what else the worker is doing. A `flush(30)` passed
 * this file on its own and failed it inside the full suite, which is the worst
 * kind of green: the assertion had run against the LOADING branch and found
 * what it expected there by accident.
 */
async function waitFor(
  rendered: Awaited<ReturnType<typeof renderScreen>>['rendered'],
  predicate: (text: string) => boolean,
  what: string,
) {
  for (let i = 0; i < 40; i++) {
    if (predicate(rendered.text())) return;
    await flush(2);
  }
  throw new Error(`timed out waiting for ${what}; last render was: ${rendered.text().slice(0, 300)}`);
}

/**
 * The screen has stopped loading, one way or the other.
 *
 * Deliberately NOT "any `openstoa.topics.` string": the sort row is on screen
 * from the first frame, so that predicate is satisfied while the query is still
 * in flight and every assertion after it reads the loading branch.
 */
const settled = (text: string) =>
  text.includes(ERROR_TITLE) || text.includes('openstoa.topics.notFound');

describe('Topics tab — a failed load is not an empty community', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('CONTRACT + INTEGRITY: an unreachable server shows the error, never "no topics"', async () => {
    global.fetch = fetchWith('offline') as unknown as typeof global.fetch;

    const { rendered } = await renderScreen(<TopicsHomeScreen />);
    await waitFor(rendered, (t) => t.includes(ERROR_TITLE), 'the failure to be stated');
    const text = rendered.text();

    expect(text, 'the failure was not stated').toContain(ERROR_TITLE);
    /*
     * The empty state cannot appear, because the list it belongs to is not
     * rendered at all — asserted on the list's absence rather than only on its
     * copy, since that holds on a real device too and it is the branch choice
     * that was wrong. The copy is checked as well, now that the harness
     * renders `ListEmptyComponent` the way the real list does.
     */
    expect(
      rendered.root.findAll((n) => (n.type as unknown as string) === 'FlatList'),
      'the list rendered alongside the error, so its empty state can still appear',
    ).toHaveLength(0);
    expect(rendered.text(), 'a failed load claimed the community was empty').not.toContain(
      'openstoa.topics.notFound',
    );
    // And the endpoint stays out of it — the reason comes from the error's
    // sentence, which no longer carries a path.
    expect(text).not.toContain('/api/');
  });

  it('CONTRACT: the error state offers a retry', async () => {
    global.fetch = fetchWith('offline') as unknown as typeof global.fetch;

    const { rendered } = await renderScreen(<TopicsHomeScreen />);
    await waitFor(rendered, (t) => t.includes(ERROR_TITLE), 'the error state');

    expect(
      rendered.root.findAll((n) => n.props?.testID === 'query-error-retry').length,
    ).toBeGreaterThan(0);
  });

  it('BOUNDARY: a successful but empty response is NOT reported as a failure', async () => {
    /*
     * The other direction: this fix must not turn "there really are no topics"
     * into an error. Both halves are now observable — the harness's FlatList
     * renders `ListEmptyComponent` when there are no rows, as the real one
     * does — so the empty copy is asserted rather than assumed.
     */
    global.fetch = fetchWith('empty') as unknown as typeof global.fetch;

    const { rendered } = await renderScreen(<TopicsHomeScreen />);
    await waitFor(rendered, settled, 'the load to settle');

    expect(rendered.text()).not.toContain(ERROR_TITLE);
    expect(rendered.root.findAll((n) => n.props?.testID === 'query-error-state')).toHaveLength(0);
    // The real empty state, said plainly, because there really are none.
    expect(rendered.text(), 'a genuinely empty list said nothing at all').toContain(
      'openstoa.topics.notFound',
    );
  });

  it('CONTRACT: the filters stay put through a failure, so the screen is still usable', async () => {
    // The header is rendered above the error rather than replaced by it: a
    // person whose "Joined" filter caused an empty-looking screen needs to see
    // the filter that is in force.
    global.fetch = fetchWith('offline') as unknown as typeof global.fetch;

    const { rendered } = await renderScreen(<TopicsHomeScreen />);
    await waitFor(rendered, (t) => t.includes(ERROR_TITLE), 'the error state');

    // `t()` returns the key with no i18n instance, except where the screen
    // supplies a defaultValue — which this one does, so the word appears.
    expect(rendered.text()).toContain('Joined');
  });
});
