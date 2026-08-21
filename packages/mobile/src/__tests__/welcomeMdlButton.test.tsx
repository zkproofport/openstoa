/**
 * The Mobile ID (mDL) button on WelcomeScreen: shown only when asked for.
 *
 * `WelcomeScreenProps.onSignInMdl` is optional, and the component's own
 * contract is "when omitted, the mDL button is hidden". That sentence is the
 * whole hiding mechanism — for the 1.0.0 corporate beta (Masse Labs) the app
 * simply stops passing the handler, so the mDL code stays on disk, intact and
 * restorable, instead of being deleted and later half-reconstructed.
 *
 * A contract that load-bearing needs a test that fails when it is broken. It
 * would be broken by making the button unconditional, or by rendering a
 * disabled placeholder instead of nothing — both of which look harmless in a
 * diff and both of which would put an experimental sign-in path in front of
 * outside testers.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → handler supplied → button present AND wired to that handler;
 *                handler omitted → button absent from the rendered text
 *   empty      → an EXPLICIT `undefined` is the same as omitting the prop, and
 *                is asserted separately: that is the shape the app actually
 *                passes (`flag && devMode ? handler : undefined`), so
 *                collapsing the two cases would leave the real one untested
 *   boundary   → the pressable COUNT is asserted, not just the copy: two
 *                buttons hidden, three shown. A button rendered with no label
 *                would slip past a text-only assertion
 *   integrity  → hiding mDL leaves the other two CTAs present and callable —
 *                the hide must not take sign-in or guest browsing with it
 *   race       → `busy` (an inflight host login) disables every CTA including
 *                mDL, so a second tap cannot start a second sign-in
 *   authz / hostile / UTF-8 / very large → N/A: this component takes three
 *                callbacks and two display props, renders copy from the
 *                catalogue, and reads no caller identity or free text.
 *
 * i18next is not initialised in this harness, so `t(key)` returns the key —
 * which is why the assertions below match on `openstoa.welcome.*` rather than
 * on English copy. That is deliberate: matching on copy would make the test
 * fail the next time the wording is edited.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { render } from './harness/render';
import { WelcomeScreen } from '../screens/onboarding/WelcomeScreen';

const SIGN_IN = 'openstoa.welcome.signIn';
const MDL = 'openstoa.welcome.signInMdl';
const GUEST = 'openstoa.welcome.continueAsGuest';

/**
 * Every pressable in the tree, whatever it contains.
 *
 * Compared by host-element NAME because that is what the react-native
 * stand-in emits (`harness/reactNative.tsx`) — the same widening `render()`
 * itself does.
 */
const PRESSABLE_TYPES = new Set(['Pressable', 'TouchableOpacity']);

function pressables(root: ReactTestInstance): ReactTestInstance[] {
  // `unknown` then a cast, exactly as `render()` does: React types a host
  // element's name as the DOM element union, which is a different platform's
  // vocabulary, and comparing it to a react-native name is a type error about
  // nothing. Widened here rather than bending the stand-in to satisfy it.
  const isPressable = (type: unknown): boolean =>
    typeof type === 'string' && PRESSABLE_TYPES.has(type as string);
  return root.findAll((n) => isPressable(n.type));
}

describe('WelcomeScreen mDL button', () => {
  it('CONTRACT: absent when no handler is supplied', async () => {
    const r = await render(
      <WelcomeScreen onSignIn={() => {}} onContinueAsGuest={() => {}} />,
    );

    expect(r.text()).not.toContain(MDL);
    expect(r.pressableWith(MDL)).toBeUndefined();
    // BOUNDARY: sign in + guest, and nothing in between. A labelless button
    // would pass the text assertions above and fail here.
    expect(pressables(r.root).length).toBe(2);
  });

  it('EMPTY: an explicit `undefined` handler hides it too', async () => {
    // This is the shape the app passes — `flag && developerMode ? fn :
    // undefined` — so it is asserted in its own right rather than assumed
    // equivalent to omitting the prop.
    const r = await render(
      <WelcomeScreen
        onSignIn={() => {}}
        onSignInMdl={undefined}
        onContinueAsGuest={() => {}}
      />,
    );

    expect(r.text()).not.toContain(MDL);
    expect(pressables(r.root).length).toBe(2);
  });

  it('CONTRACT: present, and wired, when a handler IS supplied', async () => {
    const onSignInMdl = vi.fn();
    const r = await render(
      <WelcomeScreen
        onSignIn={() => {}}
        onSignInMdl={onSignInMdl}
        onContinueAsGuest={() => {}}
      />,
    );

    expect(r.text()).toContain(MDL);
    const button = r.pressableWith(MDL);
    expect(button).toBeDefined();
    expect(pressables(r.root).length).toBe(3);

    // Present is not the same as working: a button rendered but not connected
    // would satisfy every assertion above.
    await r.press(button!);
    expect(onSignInMdl).toHaveBeenCalledTimes(1);
  });

  it('INTEGRITY: hiding mDL leaves sign-in and guest browsing intact', async () => {
    const onSignIn = vi.fn();
    const onContinueAsGuest = vi.fn();
    const r = await render(
      <WelcomeScreen onSignIn={onSignIn} onContinueAsGuest={onContinueAsGuest} />,
    );

    expect(r.text()).toContain(SIGN_IN);
    expect(r.text()).toContain(GUEST);

    await r.press(r.pressableWith(SIGN_IN)!);
    await r.press(r.pressableWith(GUEST)!);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onContinueAsGuest).toHaveBeenCalledTimes(1);
  });

  it('RACE: while a sign-in is inflight every CTA is disabled, mDL included', async () => {
    const r = await render(
      <WelcomeScreen
        onSignIn={() => {}}
        onSignInMdl={() => {}}
        onContinueAsGuest={() => {}}
        busy
      />,
    );

    for (const p of pressables(r.root)) {
      expect(p.props.disabled).toBe(true);
    }
  });
});
