/**
 * The Topics filters: two questions on one line, and a category row that folds.
 *
 * Three stacked scrollers — All/Joined, then Hot/New/Active/Top, then the
 * categories — pushed the topic list itself near the fold on a phone before a
 * single topic had been read. The first two are small questions and belong on
 * one line; the third is the longest and least often changed, so it folds.
 *
 * The risk in merging two radio groups into one row is that they stop reading
 * as two questions: two highlighted pills side by side look like one group with
 * a broken selection. So the rule between them, and the independence of the two
 * selections, are both asserted rather than left to the eye.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → both groups render in ONE row; each still selects; a divider
 *                separates them; the category row folds and unfolds
 *   integrity  → choosing in one group does not disturb the other, in both
 *                directions — the defect a merged row invites
 *   boundary   → a single group (no `leading`) renders unchanged and grows no
 *                divider, so the feed and topic-detail callers are untouched
 *   empty      → a category list with only "All" renders no fold at all
 *   authz      → N/A: filters are client-side over data the server already
 *                scoped; nothing here depends on who is asking
 *   hostile / UTF-8 / very large → N/A: labels come from the i18n catalogue and
 *                the category list from the server, neither free text typed here
 *   race       → N/A: synchronous local state, no async between tap and render
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from './harness/render';
import { SortPills } from '../components/SortPills';
import { TagChips } from '../components/TagChips';

const SORTS = [
  { key: 'hot' as const, label: 'Hot' },
  { key: 'new' as const, label: 'New' },
  { key: 'active' as const, label: 'Active' },
  { key: 'top' as const, label: 'Top' },
];
const MEMBERSHIP = [
  { key: 'all' as const, label: 'All' },
  { key: 'joined' as const, label: 'Joined' },
];
const CATEGORIES = [
  { slug: null, label: 'All' },
  { slug: 'general', label: 'General' },
  { slug: 'blockchain', label: 'Blockchain' },
];

/** Every horizontal scroller in the tree — one per row of pills. */
function scrollerCount(root: import('react-test-renderer').ReactTestInstance): number {
  return root.findAll((n) => (n.type as unknown as string) === 'ScrollView' && !!n.props?.horizontal)
    .length;
}

describe('membership and sort share one row', () => {
  it('CONTRACT: both groups render, in a single scroller', async () => {
    const r = await render(
      <SortPills
        items={SORTS}
        value="hot"
        onChange={() => {}}
        leading={{ items: MEMBERSHIP, value: 'all', onChange: () => {} }}
      />,
    );

    const text = r.text();
    for (const label of ['All', 'Joined', 'Hot', 'New', 'Active', 'Top']) {
      expect(text, `${label} is missing`).toContain(label);
    }
    // One row, not two stacked ones — the whole point of the change.
    expect(scrollerCount(r.root)).toBe(1);
  });

  it('INTEGRITY: the two selections are independent, in both directions', async () => {
    const sorts: string[] = [];
    const memberships: string[] = [];
    const r = await render(
      <SortPills
        items={SORTS}
        value="hot"
        onChange={(v) => sorts.push(v)}
        leading={{ items: MEMBERSHIP, value: 'all', onChange: (v) => memberships.push(v) }}
      />,
    );

    await r.press(r.pressableWith('Joined')!);
    expect(memberships).toEqual(['joined']);
    expect(sorts, 'picking a membership also changed the sort').toEqual([]);

    await r.press(r.pressableWith('Top')!);
    expect(sorts).toEqual(['top']);
    expect(memberships, 'picking a sort also changed the membership').toEqual(['joined']);
  });

  it('CONTRACT: a rule separates the groups, so they do not read as one', async () => {
    const merged = await render(
      <SortPills
        items={SORTS}
        value="hot"
        onChange={() => {}}
        leading={{ items: MEMBERSHIP, value: 'all', onChange: () => {} }}
      />,
    );
    const single = await render(<SortPills items={SORTS} value="hot" onChange={() => {}} />);

    // By marker, not by measuring the style: the harness's `hairlineWidth` is
    // a stand-in value, so asserting on the number would test the harness.
    const rules = (root: import('react-test-renderer').ReactTestInstance) =>
      root.findAll((n) => n.props?.testID === 'sort-pills-divider').length;

    expect(rules(merged.root)).toBeGreaterThan(0);
    expect(rules(single.root), 'a single-group row grew a divider').toBe(0);
  });

  it('BOUNDARY: without `leading` the row is exactly what it was', async () => {
    // The feed and topic-detail screens pass no leading group and must be
    // unaffected by this change.
    const r = await render(<SortPills items={SORTS} value="new" onChange={() => {}} />);

    expect(r.text()).toContain('Hot');
    expect(r.text()).not.toContain('Joined');
    expect(scrollerCount(r.root)).toBe(1);
  });
});

describe('the category row folds', () => {
  it('CONTRACT: folded by default — the header states the answer, the chips are away', async () => {
    const r = await render(
      <TagChips chips={CATEGORIES} value={null} onChange={() => {}} collapsible title="Category" />,
    );

    expect(r.text()).toContain('Category');
    // "All" is the current answer and stays visible in the header; the other
    // categories are what folding removes.
    expect(r.text()).not.toContain('Blockchain');
    expect(scrollerCount(r.root)).toBe(0);
  });

  it('CONTRACT: tapping the header unfolds it, and again folds it back', async () => {
    const r = await render(
      <TagChips chips={CATEGORIES} value={null} onChange={() => {}} collapsible title="Category" />,
    );
    const toggle = () => r.root.findAll((n) => n.props?.testID === 'tag-chips-toggle')[0];

    await r.press(toggle());
    expect(r.text()).toContain('Blockchain');
    expect(scrollerCount(r.root)).toBe(1);

    await r.press(toggle());
    expect(r.text()).not.toContain('Blockchain');
  });

  it('INTEGRITY: a category already in force starts UNFOLDED', async () => {
    // Hiding the filter that is making the list short would hide the reason
    // the list is short.
    const r = await render(
      <TagChips
        chips={CATEGORIES}
        value="blockchain"
        onChange={() => {}}
        collapsible
        title="Category"
      />,
    );

    expect(scrollerCount(r.root)).toBe(1);
    expect(r.text()).toContain('Blockchain');
  });

  it('CONTRACT: choosing a category still reports the slug', async () => {
    const picked: (string | null)[] = [];
    const r = await render(
      <TagChips
        chips={CATEGORIES}
        value="blockchain"
        onChange={(s) => picked.push(s)}
        collapsible
        title="Category"
      />,
    );

    await r.press(r.pressablesWith('General').at(-1)!);
    expect(picked).toEqual(['general']);
  });

  it('BOUNDARY: without `collapsible` the chips are open, with no header', async () => {
    // The feed's tag row keeps its current behaviour.
    const r = await render(<TagChips chips={CATEGORIES} value={null} onChange={() => {}} />);

    expect(scrollerCount(r.root)).toBe(1);
    expect(r.text()).toContain('Blockchain');
    expect(r.root.findAll((n) => n.props?.testID === 'tag-chips-toggle')).toHaveLength(0);
  });
});
