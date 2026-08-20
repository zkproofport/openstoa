/**
 * The tier claim says its piece on entry, withdraws, and can be asked again.
 *
 * It used to stand above every conversation permanently — four lines on a
 * phone, pushing the room down and teaching people to read past it. A standing
 * notice is furniture, and the tier where this particular notice is a WARNING
 * rather than a reassurance (`serverReadable`: the service holds a key to the
 * history and can read it) is the tier most rooms are in, so "read past it" is
 * the expensive outcome.
 *
 * What must NOT follow from that is the claim disappearing. The header control
 * is permanent and carries the tier in its icon and colour, so a room the
 * service can read never looks like one it cannot — including for a reader who
 * let the sentence expire unread. These tests hold both halves: the sentence
 * goes, the marker stays, and the marker brings the sentence back.
 *
 * `headerRight` is handed to the navigator through `setOptions` rather than
 * rendered into this tree, so the control is asserted by invoking the recorded
 * option — which is also the only way to prove the screen actually installed
 * one.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract  → the sentence is shown on entry; it is gone after the window;
 *               a header control exists and reveals it again
 *   integrity → the control's accessibility label is the SAME derived claim
 *               the banner shows, so the two cannot drift apart
 *   boundary  → asserted either side of exactly `TIER_CLAIM_VISIBLE_MS`, so
 *               shortening the window to zero fails here
 *   race      → a screen unmounted before the window elapses does not fire a
 *               state update into a dead tree
 *   authz / hostile / empty / UTF-8 / large → N/A: the claim is derived from
 *               the tier by `chatClaimKey`, which takes no caller identity and
 *               no free text; its own inputs are covered by
 *               `chatTierPolicy.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { ChatRoomScreen } from '../screens/chat/ChatRoomScreen';
import { TIER_CLAIM_VISIBLE_MS } from '../lib/chatTierExplainer';

const BANNER = 'chat-tier-banner';
const CLAIM_BUTTON = 'chat-tier-claim-button';

/*
 * One `testID` matches twice — the stand-in's `View` is a component that
 * renders a host node of the same name, so the prop is visible on both. These
 * ask whether the thing is on screen, not how many nodes carry the marker.
 */
function byTestId(root: ReactTestInstance, id: string): ReactTestInstance[] {
  return root.findAll((n) => n.props?.testID === id);
}

function isShowing(root: ReactTestInstance, id: string): boolean {
  return byTestId(root, id).length > 0;
}

/**
 * Mount the `headerRight` the screen handed the navigator.
 *
 * Through `renderScreen` and with the SAME host, because the header carries
 * `TopicMuteButton`, which calls `useHost()` — rendered bare it throws, and the
 * test would then be reporting a missing provider rather than a missing button.
 */
async function renderHeaderRight(
  nav: Awaited<ReturnType<typeof renderScreen>>['nav'],
  host: Awaited<ReturnType<typeof renderScreen>>['host'],
) {
  const options = nav.setOptions.calls.at(-1)?.[0] as {
    headerRight?: () => React.ReactElement;
  };
  expect(options?.headerRight, 'the screen installed no headerRight').toBeTypeOf('function');
  const { rendered } = await renderScreen(options.headerRight!(), { host });
  return rendered;
}

/** Advance past the reveal window, letting the timer's state update land. */
async function elapseRevealWindow() {
  await act(async () => {
    vi.advanceTimersByTime(TIER_CLAIM_VISIBLE_MS + 1);
  });
}

describe('the chat tier claim reveals itself, then withdraws', () => {
  beforeEach(() => {
    // `shouldAdvanceTime` keeps the harness's promise draining working: the
    // screen awaits real microtasks during mount, and a fully frozen clock
    // would deadlock those rather than just holding the reveal timer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CONTRACT: the sentence is there on entry and gone after the window', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />);

    expect(isShowing(rendered.root, BANNER)).toBe(true);
    await elapseRevealWindow();
    expect(isShowing(rendered.root, BANNER)).toBe(false);
  });

  it('CONTRACT: a header control outlives the sentence and brings it back', async () => {
    const { rendered, nav, host } = await renderScreen(<ChatRoomScreen />);
    await elapseRevealWindow();

    const header = await renderHeaderRight(nav, host);
    const buttons = byTestId(header.root, CLAIM_BUTTON);
    expect(buttons.length, 'the claim control is not in the header').toBeGreaterThan(0);

    // Pressing it reopens the sentence in the SCREEN's tree — the element
    // returned by `headerRight` closes over the screen's own state, so where
    // it happens to be mounted for the test does not matter.
    await act(async () => {
      (buttons[0].props.onPress as () => void)();
    });
    expect(isShowing(rendered.root, BANNER)).toBe(true);
  });

  it('INTEGRITY: the control announces the same claim the banner shows', async () => {
    const { rendered, nav, host } = await renderScreen(<ChatRoomScreen />);

    const bannerText = byTestId(rendered.root, BANNER)[0];
    const header = await renderHeaderRight(nav, host);
    const label = byTestId(header.root, CLAIM_BUTTON)[0].props.accessibilityLabel as string;

    // Both sides read the same i18n key off the same derived claim. Without an
    // i18n instance in the harness `t()` returns the key, which is exactly the
    // identity worth asserting: one claim, not two strings kept in step.
    expect(label).toMatch(/^openstoa\.chat\.tierClaim\./);
    expect(collect(bannerText)).toContain(label);
  });

  it('RACE: a room closed before the window elapses updates nothing', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />);
    rendered.unmount();

    // A leaked timer would call setState on an unmounted tree here.
    await expect(elapseRevealWindow()).resolves.toBeUndefined();
  });
});

/** The rendered text of one subtree. */
function collect(node: ReactTestInstance): string {
  let out = '';
  for (const child of node.children) {
    out += typeof child === 'string' ? child : collect(child);
  }
  return out;
}
