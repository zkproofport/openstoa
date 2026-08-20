/**
 * The category row does not vanish when its request fails.
 *
 * Reported as "카테고리가 안 보인다" — categories missing from the Topics tab —
 * and it was neither the component nor the API: both were fine. The row renders
 * on `categoryChips.length > 1`, and a failed `/api/categories` leaves exactly
 * one chip, the local "All". So the whole row disappeared, silently, and from
 * the outside that is indistinguishable from the feature having been removed.
 * The report arrived while sessions were expiring, which is precisely when that
 * request answers 401.
 *
 * Same shape as the five screens fixed alongside it: a failure reported as
 * absence. This is the last one, asserted at the SCREEN, because the bug was
 * never in a component — it was in which branch the screen chose.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a failed category load states the failure and offers a retry
 *   integrity  → the topic list still renders; one failed filter must not take
 *                the page down with it
 *   boundary   → a successful load renders the fold; a server with NO
 *                categories renders neither the fold nor the failure, because
 *                there is nothing to filter by and nothing went wrong
 *   boundary   → one category is still a choice (All + it), so the fold appears
 *   UTF-8      → Korean and emoji category names survive to the header
 *   empty      → an absent `categories` key is treated as none, not as an error
 *   external   → the failure exercised is an unreachable server (aeroplane
 *                mode) and a 401 (the expired session that produced the report)
 *   hostile / very large / authz / race → N/A: the row is a branch on one
 *                query's state over a public, server-scoped list.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import { TopicsHomeScreen } from '../screens/topics/TopicsHomeScreen';

const FAILED = 'openstoa.topics.category.loadFailed';
const FOLD = 'tag-chips-toggle';
const FAILED_ROW = 'category-load-failed';

type CategoryMode =
  | { kind: 'offline' }
  | { kind: 'unauthorized' }
  | { kind: 'ok'; categories: unknown[] }
  | { kind: 'missingKey' };

/**
 * Answers `/api/categories` per `mode`; topics always succeed and are empty.
 *
 * Returns the answered-promise alongside, because "has the category query
 * settled?" cannot be read off the screen in the cases that assert nothing
 * appears. Waiting on a render condition there would satisfy itself against the
 * sort row, which is present from the first frame — the exact false green this
 * file is meant to rule out.
 */
function fetchWith(mode: CategoryMode) {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/api/categories')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ topics: [] }),
        text: async () => '',
      } as unknown as Response;
    }
    try {
      if (mode.kind === 'offline') throw new TypeError('Network request failed');
      if (mode.kind === 'unauthorized') {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Not authenticated' }),
          text: async () => '{"error":"Not authenticated"}',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (mode.kind === 'missingKey' ? {} : { categories: mode.categories }),
        text: async () => '',
      } as unknown as Response;
    } finally {
      // Also on the throw path: a rejected request has still been answered.
      answer();
    }
  });
  return { fn, answered };
}

const cat = (slug: string, name: string) => ({
  id: `id-${slug}`,
  name,
  slug,
  description: null,
  icon: null,
  sortOrder: 0,
  createdAt: '2026-05-21T07:17:34.634Z',
});

type Rendered = Awaited<ReturnType<typeof renderScreen>>['rendered'];

const has = (r: Rendered, testID: string) =>
  r.root.findAll((n) => n.props?.testID === testID).length > 0;

/**
 * Mount, and return once the category query has actually settled.
 *
 * The wait is on the REQUEST being answered, not on a render condition. Every
 * case here asks what the category row does, and in two of them the answer is
 * "nothing appears" — a render predicate there would satisfy itself against the
 * sort row, which is on screen from the first frame, and report a pass before
 * the query had even resolved.
 */
async function mount(mode: CategoryMode): Promise<Rendered> {
  const { fn, answered } = fetchWith(mode);
  global.fetch = fn as unknown as typeof global.fetch;

  const { rendered } = await renderScreen(<TopicsHomeScreen />);
  await answered;
  // React-query still has to move the result into state and re-render. A
  // rejection travels through more turns than a resolution, so drain until the
  // row has decided — or, for the cases where it decides on nothing, until the
  // budget runs out, which is the same wait either way.
  for (let i = 0; i < 40 && !has(rendered, FOLD) && !has(rendered, FAILED_ROW); i++) {
    await flush(2);
  }
  return rendered;
}

describe('Topics tab — the category row', () => {
  const realFetch = global.fetch;

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it.each([
    ['an unreachable server', { kind: 'offline' } as CategoryMode],
    ['an expired session (401)', { kind: 'unauthorized' } as CategoryMode],
  ])('CONTRACT: %s says so instead of removing the row', async (_label, mode) => {
    const rendered = await mount(mode);

    expect(has(rendered, FAILED_ROW), 'the row disappeared instead of reporting').toBe(true);
    expect(rendered.text()).toContain(FAILED);
    // …and the remedy, since a retry is the only thing that fixes it.
    expect(rendered.text()).toContain('openstoa.common.retry');
    // One row, one state: the fold cannot also be there.
    expect(has(rendered, FOLD), 'the fold rendered alongside the failure').toBe(false);
  });

  it('INTEGRITY: one failed filter does not take the page down', async () => {
    // The topics themselves loaded fine. Losing the ability to narrow by
    // category must not cost the list, or the sort row above it.
    const rendered = await mount({ kind: 'offline' });

    expect(rendered.text()).toContain('openstoa.topics.sort.');
    expect(rendered.text()).not.toContain('openstoa.common.loadFailed.topics');
  });

  it('CONTRACT: a successful load renders the fold', async () => {
    const rendered = await mount({
      kind: 'ok',
      categories: [cat('general', 'General'), cat('blockchain', 'Blockchain')],
    });

    expect(has(rendered, FOLD)).toBe(true);
    expect(has(rendered, FAILED_ROW)).toBe(false);
    // Folded, so the header carries the current answer rather than the chips.
    expect(rendered.text()).toContain('openstoa.topics.category.all');
    expect(rendered.text()).not.toContain('Blockchain');
  });

  it('BOUNDARY: one category is still a choice', async () => {
    // All + one is two options, which is a filter. The row appearing at
    // exactly two is the boundary the `length > 1` guard sits on.
    const rendered = await mount({ kind: 'ok', categories: [cat('general', 'General')] });

    expect(has(rendered, FOLD)).toBe(true);
  });

  it.each([
    ['no categories at all', { kind: 'ok', categories: [] } as CategoryMode],
    ['a response with no `categories` key', { kind: 'missingKey' } as CategoryMode],
  ])('EMPTY: %s is neither a fold nor a failure', async (_label, mode) => {
    /*
     * Nothing to filter by and nothing went wrong. The failure copy here would
     * be a lie, and a fold containing only "All" would be a control that does
     * nothing.
     */
    const rendered = await mount(mode);

    expect(has(rendered, FOLD)).toBe(false);
    expect(has(rendered, FAILED_ROW)).toBe(false);
  });

  it('UTF-8: Korean and emoji category names survive', async () => {
    const rendered = await mount({
      kind: 'ok',
      categories: [cat('korean', '한국어 커뮤니티'), cat('fun', '🎉 Fun')],
    });

    expect(has(rendered, FOLD), 'the fold never appeared').toBe(true);
    // Open it — folded, only the selected label ("All") is on screen.
    await rendered.press(rendered.root.findAll((n) => n.props?.testID === FOLD)[0]);

    expect(rendered.text()).toContain('한국어 커뮤니티');
    expect(rendered.text()).toContain('🎉 Fun');
  });

  it('CONTRACT: the failure row retries, and recovers', async () => {
    // A retry that does not actually re-request is a button that lies. The
    // second answer succeeds, so the row must turn into the fold.
    const rendered = await mount({ kind: 'offline' });
    expect(has(rendered, FAILED_ROW)).toBe(true);

    const { fn: succeeding, answered } = fetchWith({
      kind: 'ok',
      categories: [cat('general', 'General')],
    });
    global.fetch = succeeding as unknown as typeof global.fetch;

    await rendered.press(rendered.root.findAll((n) => n.props?.testID === FAILED_ROW)[0]);
    await answered;
    for (let i = 0; i < 40 && !has(rendered, FOLD); i++) await flush(2);

    expect(has(rendered, FOLD), 'the retry did not recover the row').toBe(true);
    expect(has(rendered, FAILED_ROW)).toBe(false);
  });
});
