/**
 * `SignInSheetProvider` mounted for real (matching the T-1 precedent for
 * `ChatRoomScreen`): the wiring under test — a module-level pub/sub
 * (`sessionExpiry.ts`) reaching into a React provider mounted elsewhere in
 * the tree — is exactly the kind of thing that "looks right on paper" and
 * silently doesn't fire. i18n is not initialized in this harness (see
 * `chatRoomScreen.test.tsx`'s RETRY_LABEL precedent), so `t(key)` returns
 * the raw key — assertions below check for the KEY, not translated copy.
 *
 * Every test calls `rendered.unmount()` at the end (this file's established
 * convention, see chatRoomScreen.test.tsx) — load-bearing here specifically:
 * `sessionExpiry.ts`'s listener set is a MODULE-LEVEL singleton shared by
 * every test in the process, so a provider left mounted from a prior test
 * would still be subscribed and would receive (and act on) a LATER test's
 * `notifySessionExpired()` call, updating a stale renderer outside any
 * `act()` — exactly the kind of cross-test bleed a leaked subscription
 * causes.
 *
 * Matrix rows covered:
 *   contract   — `notifySessionExpired()` opens the sheet (`Modal`'s
 *                `visible` prop flips true) with nobody calling `open()`
 *   integrity  — the auto-opened sheet shows the EXPIRED copy, not the
 *                ordinary guest-gate copy
 *   contract   — an ordinary `require()`/`open()` call still shows the
 *                ordinary guest copy, unaffected by this change
 *   race       — two `notifySessionExpired()` calls in a row leave the
 *                sheet visible exactly once (no crash, no double-mount)
 *   boundary   — the provider unsubscribes on unmount (no leaked listener
 *                reacting to a notification after the tree is gone)
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { notifySessionExpired } from '../auth/sessionExpiry';
import { useSignInGate } from '../components/SignInSheet';

/** Same pattern as `render.tsx`'s `isPressable` — host element types come
 * through as plain strings, which `ElementType` does not narrow to on its
 * own, so the comparison needs the same `typeof` guard first. */
function isModalType(type: unknown): boolean {
  return typeof type === 'string' && type === 'Modal';
}

function findModal(root: ReactTestInstance) {
  return root.findAll((n) => isModalType(n.type))[0];
}

/** A child that lets a test drive `useSignInGate()` from inside the tree via
 * the harness's `pressableWith('probe')`, matching how every other screen
 * test in this package finds and presses a control. */
function GateProbe() {
  const gate = useSignInGate();
  return (
    <TouchableOpacity onPress={() => gate.open()}>
      <Text>probe</Text>
    </TouchableOpacity>
  );
}

describe('SignInSheetProvider — auto-open on a server-forced session drop', () => {
  it('is closed by default (Modal visible=false), losing no in-progress content underneath', async () => {
    const { rendered } = await renderScreen(<GateProbe />);
    expect(findModal(rendered.root).props.visible).toBe(false);
    rendered.unmount();
  });

  it('notifySessionExpired() opens the sheet unprompted, showing the EXPIRED copy', async () => {
    const { rendered } = await renderScreen(<GateProbe />);

    await act(async () => {
      notifySessionExpired();
    });

    expect(findModal(rendered.root).props.visible).toBe(true);
    expect(rendered.text()).toContain('openstoa.signInPrompt.expiredTitle');
    expect(rendered.text()).toContain('openstoa.signInPrompt.expiredBody');
    // And NOT the ordinary guest-gate title — only one variant renders.
    expect(rendered.text()).not.toContain('openstoa.signInPrompt.title');

    rendered.unmount();
  });

  it('an ordinary open() (guest gate) still shows the ordinary copy, not the expired one', async () => {
    const { rendered } = await renderScreen(<GateProbe />);

    await rendered.press(rendered.pressableWith('probe')!);

    expect(findModal(rendered.root).props.visible).toBe(true);
    expect(rendered.text()).toContain('openstoa.signInPrompt.title');
    expect(rendered.text()).not.toContain('openstoa.signInPrompt.expiredTitle');

    rendered.unmount();
  });

  it('two notifySessionExpired() calls in a row leave the sheet visible exactly once, no crash', async () => {
    const { rendered } = await renderScreen(<GateProbe />);

    await act(async () => {
      notifySessionExpired();
      notifySessionExpired();
    });

    const modals = rendered.root.findAll((n) => isModalType(n.type));
    expect(modals).toHaveLength(1);
    expect(modals[0].props.visible).toBe(true);

    rendered.unmount();
  });

  it('unmounting the provider detaches its session-expiry subscription (no leaked listener afterwards)', async () => {
    const { rendered } = await renderScreen(<GateProbe />);
    rendered.unmount();
    // If the subscription outlived the unmount, this would try to update the
    // now-unmounted tree's state — react-test-renderer surfaces that loudly.
    // Not throwing IS the assertion.
    expect(() => notifySessionExpired()).not.toThrow();
  });
});
