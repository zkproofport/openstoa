/**
 * All three visibility tiers are selectable when creating a topic, and the one
 * picked is the one sent.
 *
 * `private` and `secret` sat behind a "Soon" badge on this screen from the day
 * it was scaffolded (`a613630`) and were never reopened — the web form enabled
 * `private` some time later and the mini-app was not updated with it. Nothing
 * server-side was ever missing: `/api/topics` has validated all three since it
 * was written, `chatTierPolicy` gives private and secret per-epoch keys the
 * server may not hold, and `mobileTransport.getServerRoot` already reads the
 * archive-root route's 403 for those tiers as "nothing deposited" rather than
 * as a failure. The badge was the only thing in the way.
 *
 * These tests pin the part a future edit could quietly undo: re-adding `wip`
 * to a row makes its `onPress` a no-op, which looks like a styling change in a
 * diff and silently removes a tier from the product.
 *
 * Assertions target i18n KEYS, not English copy. The screen harness mounts
 * `react-i18next` without an initialised instance, so `t()` returns the key —
 * which is the more durable thing to assert against anyway, since rewording a
 * label should not fail a test about which tiers exist.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → every tier renders WITHOUT the coming-soon badge; pressing
 *                `secret` selects it; the POST body carries what was picked
 *   boundary   → all three tiers, each asserted end to end, not just the one
 *                that used to work
 *   integrity  → the request body's `visibility` equals the row pressed, so a
 *                picker wired to the wrong state variable fails here
 *   authz      → N/A: this screen sits behind the app's auth gate, and the
 *                tier decides who may JOIN, which the server enforces —
 *                covered by `tierAccess-routes.test.ts` on the web side
 *   hostile / empty / UTF-8 / large → N/A: `visibility` is a closed set of
 *                three literals chosen by tapping, never typed. The server
 *                validates it regardless (`VALID_VISIBILITIES`), covered there.
 *   race       → N/A: no async step between picking a tier and submitting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { TopicCreateScreen } from '../screens/topics/TopicCreateScreen';

const K = 'openstoa.topicCreate';
const ROW = {
  public: `${K}.visibilityOptions.public`,
  private: `${K}.visibilityOptions.private`,
  secret: `${K}.visibilityOptions.secret`,
} as const;
const SOON = `${K}.comingSoonShort`;
const SUBMIT = `${K}.submit`;

const CATEGORY = { id: 'cat-1', name: 'General', slug: 'general' };

/** Captures every POST /api/topics body the screen sends. */
function createFetch(): { fetch: ReturnType<typeof vi.fn>; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json, text: async () => '' }) as unknown as Response;

    if (url.includes('/api/categories')) return ok({ categories: [CATEGORY] });
    if (url.includes('/api/topics') && (init?.method ?? 'GET') === 'POST') {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return ok({ topic: { id: '99999999-8888-4777-8666-555555555555' } });
    }
    return ok({});
  });
  return { fetch, bodies };
}

/** The rendered text of one subtree — the harness only exposes it tree-wide. */
function collect(node: ReactTestInstance): string {
  let out = '';
  for (const child of node.children) {
    out += typeof child === 'string' ? child : collect(child);
  }
  return out;
}

/** Type a title — the other half of `canSubmit`; the category self-selects. */
async function fillTitle(root: ReactTestInstance, value: string) {
  // Host elements are compared BY NAME — the stand-in renders 'TextInput' —
  // and `ElementType` does not overlap a string literal, so the comparison is
  // widened the same way `harness/render.tsx` widens its pressable check.
  const input = root.findAll((n) => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => {
    (input.props.onChangeText as (t: string) => void)(value);
  });
}

describe('topic create — every visibility tier is offered', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    const { fetch } = createFetch();
    global.fetch = fetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('CONTRACT: no tier is marked coming-soon any more', async () => {
    const { rendered } = await renderScreen(<TopicCreateScreen />);

    // The badge string is still used by the proof-type picker below, so this
    // asks the narrower question: is it inside one of the three tier rows?
    for (const [tier, key] of Object.entries(ROW)) {
      const row = rendered.pressableWith(key);
      expect(row, `no row rendered for ${tier}`).toBeDefined();
      expect(collect(row!), `${tier} still carries a coming-soon badge`).not.toContain(SOON);
    }
  });

  it('CONTRACT: pressing Secret selects it — the row is not an inert label', async () => {
    const { rendered } = await renderScreen(<TopicCreateScreen />);

    // A selected row shows the check mark; an ignored press leaves Public's.
    expect(collect(rendered.pressableWith(ROW.secret)!)).not.toContain('✓');
    await rendered.press(rendered.pressableWith(ROW.secret)!);
    expect(collect(rendered.pressableWith(ROW.secret)!)).toContain('✓');
    expect(collect(rendered.pressableWith(ROW.public)!)).not.toContain('✓');
  });

  it.each([
    ['public', ROW.public],
    ['private', ROW.private],
    ['secret', ROW.secret],
  ])('INTEGRITY: picking %s sends that visibility', async (expected, key) => {
    const bodies: Record<string, unknown>[] = [];
    const captured = createFetch();
    global.fetch = captured.fetch as unknown as typeof global.fetch;

    const { rendered } = await renderScreen(<TopicCreateScreen />);
    await fillTitle(rendered.root, 'Tier test');
    await rendered.press(rendered.pressableWith(key)!);
    await rendered.press(rendered.pressableWith(SUBMIT)!);

    bodies.push(...captured.bodies);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].visibility).toBe(expected);
  });
});
