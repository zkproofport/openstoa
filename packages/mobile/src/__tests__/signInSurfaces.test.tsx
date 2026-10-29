/**
 * The Mobile ID (mDL) button: hidden for the 1.0.0 corporate beta, and hidden
 * from EVERY sign-in surface rather than from one of them.
 *
 * The original version of this file tested a per-screen seam —
 * `WelcomeScreenProps.onSignInMdl`, whose contract was "when omitted, the mDL
 * button is hidden". That contract held, and the app was still shipping the mDL
 * button: `SignInSheet` (the bottom sheet a guest gets when they hit a gated
 * action, and the one that opens itself on session expiry) kept its own copy of
 * the button list and its own translation keys, so hiding mDL on Welcome did
 * nothing to it. A tester found it on production-shaped staging.
 *
 * So the seam moved. `auth/signInMethods.ts` is now the single place that
 * decides which methods are offered; both surfaces render that list through
 * `<SignInMethodButtons>`, and neither keeps a list of its own. These tests
 * follow it there — the offered set is asserted directly (it is plain data, no
 * mounting required), and then the two surfaces are asserted to render exactly
 * what the list says.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → mDL is absent from `offeredSignInMethods()` under BOTH
 *                Developer Mode settings — `enabled: false` outranks
 *                `developerOnly`, which is the whole point of the kill switch
 *   contract   → WelcomeScreen renders one button per offered method, wired to
 *                `onSignIn` with that method's id; `SignInSheet` renders the
 *                same set
 *   integrity  → mDL is not deleted, only un-offered: it is still present in
 *                `SIGN_IN_METHODS` with its label key, so the restore is one
 *                flag and not a reconstruction
 *   integrity  → hiding mDL leaves sign-in and guest browsing intact and
 *                callable — the hide must not take the other CTAs with it
 *   boundary   → the pressable COUNT is asserted, not only the copy: a button
 *                rendered with no label would slip past a text-only assertion.
 *                The empty list (every method disabled) renders nothing at all
 *   empty      → a caller that passes no `methods` at all gets the
 *                conservative default, not "everything"
 *   race       → `busy` (an inflight host login) disables every CTA, so a
 *                second tap cannot start a second sign-in
 *   authz / hostile / UTF-8 / very large → N/A: this surface takes callbacks
 *                and display props, renders copy from the catalogue, and reads
 *                no caller identity or free text.
 *
 * i18next is not initialised in this harness, so `t(key)` returns the key —
 * which is why the assertions below match on `openstoa.*` keys rather than on
 * English copy. That is deliberate: matching on copy would make the test fail
 * the next time the wording is edited.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { render } from './harness/render';
import { renderScreen, hostDouble } from './harness/screen';
import { WelcomeScreen } from '../screens/onboarding/WelcomeScreen';
import { useSignInGate } from '../components/SignInSheet';
import { Text, TouchableOpacity } from 'react-native';
import {
  SIGN_IN_METHODS,
  offeredSignInMethods,
  isSignInMethodOffered,
  type SignInMethod,
} from '../auth/signInMethods';

const OIDC = 'openstoa.signIn.method.oidc';
const MDL = 'openstoa.signIn.method.mdl';
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

/** The mDL entry as the app knows it — offered or not, it still exists. */
const mdlMethod = SIGN_IN_METHODS.find((m) => m.id === 'mdl') as SignInMethod;

describe('the offered sign-in methods (auth/signInMethods.ts)', () => {
  it('CONTRACT: mDL is not offered, with Developer Mode off OR on', () => {
    // `enabled: false` outranks `developerOnly` — that is what makes this a
    // release kill switch rather than another Developer Mode toggle. Both
    // settings are asserted because only one of them was ever the gate before.
    for (const developerMode of [false, true]) {
      const offered = offeredSignInMethods({ developerMode });
      expect(offered.map((m) => m.id)).not.toContain('mdl');
      expect(isSignInMethodOffered('mdl', { developerMode })).toBe(false);
    }
  });

  it('CONTRACT: OIDC is offered either way — the hide is mDL-specific', () => {
    for (const developerMode of [false, true]) {
      expect(isSignInMethodOffered('oidc', { developerMode })).toBe(true);
    }
  });

  it('INTEGRITY: mDL is un-offered, NOT deleted — restoring it is one flag', () => {
    expect(mdlMethod).toBeDefined();
    expect(mdlMethod.enabled).toBe(false);
    // The label key survives, so the restore is a flag flip and not a
    // reconstruction of copy that was deleted and half-remembered.
    expect(mdlMethod.labelKey).toBe(MDL);
    // And the gate it goes back BEHIND is still Developer Mode, which is where
    // it lived before the beta hid it — `enabled` did not replace that gate,
    // it stacked on top of it.
    expect(mdlMethod.developerOnly).toBe(true);
  });
});

describe('WelcomeScreen renders the offered methods and nothing else', () => {
  it('EMPTY: no `methods` prop → the conservative default, which excludes mDL', async () => {
    const r = await render(
      <WelcomeScreen onSignIn={() => {}} onContinueAsGuest={() => {}} />,
    );

    expect(r.text()).not.toContain(MDL);
    expect(r.pressableWith(MDL)).toBeUndefined();
    expect(r.text()).toContain(OIDC);
    // BOUNDARY: sign in + guest, and nothing in between. A labelless button
    // would pass the text assertions above and fail here.
    expect(pressables(r.root).length).toBe(2);
  });

  it('CONTRACT: what the app actually passes (the offered set) hides mDL too', async () => {
    // This is the real call shape — `methods={useOfferedSignInMethods()}` in
    // OpenStoaApp — so it is asserted in its own right rather than assumed
    // equivalent to omitting the prop.
    const r = await render(
      <WelcomeScreen
        methods={offeredSignInMethods({ developerMode: true })}
        onSignIn={() => {}}
        onContinueAsGuest={() => {}}
      />,
    );

    expect(r.text()).not.toContain(MDL);
    expect(pressables(r.root).length).toBe(2);
  });

  it('CONTRACT: a method that IS offered renders, and is wired to its id', async () => {
    // Proves the screen is a renderer of the list rather than a hardcoded
    // stack: hand it mDL explicitly and the button appears, wired to 'mdl'.
    // If this ever failed while the tests above passed, the buttons would be
    // hardcoded again and the whole seam would be decoration.
    const onSignIn = vi.fn();
    const r = await render(
      <WelcomeScreen
        methods={[...SIGN_IN_METHODS]}
        onSignIn={onSignIn}
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
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith('mdl');
  });

  it('BOUNDARY: an empty method list renders no sign-in buttons at all', async () => {
    const r = await render(
      <WelcomeScreen
        methods={[]}
        onSignIn={() => {}}
        onContinueAsGuest={() => {}}
      />,
    );

    expect(r.text()).not.toContain(OIDC);
    expect(r.text()).not.toContain(MDL);
    // Guest browsing survives — the only CTA left.
    expect(pressables(r.root).length).toBe(1);
    expect(r.text()).toContain(GUEST);
  });

  it('INTEGRITY: hiding mDL leaves sign-in and guest browsing intact', async () => {
    const onSignIn = vi.fn();
    const onContinueAsGuest = vi.fn();
    const r = await render(
      <WelcomeScreen onSignIn={onSignIn} onContinueAsGuest={onContinueAsGuest} />,
    );

    expect(r.text()).toContain(OIDC);
    expect(r.text()).toContain(GUEST);

    await r.press(r.pressableWith(OIDC)!);
    await r.press(r.pressableWith(GUEST)!);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith('oidc');
    expect(onContinueAsGuest).toHaveBeenCalledTimes(1);
  });

  it('RACE: while a sign-in is inflight every CTA is disabled', async () => {
    const r = await render(
      <WelcomeScreen
        methods={[...SIGN_IN_METHODS]}
        onSignIn={() => {}}
        onContinueAsGuest={() => {}}
        busy
      />,
    );

    for (const p of pressables(r.root)) {
      expect(p.props.disabled).toBe(true);
    }
  });
});

/** Opens the sheet from inside the provider, the way a gated action does. */
function GateProbe() {
  const gate = useSignInGate();
  return (
    <TouchableOpacity onPress={() => gate.open()}>
      <Text>probe</Text>
    </TouchableOpacity>
  );
}

describe('SignInSheet — the OTHER surface, which used to keep its own list', () => {
  it('CONTRACT: the opened sheet offers OIDC and does not offer mDL', async () => {
    // The defect this whole change is about: this sheet showed "Sign in with
    // Mobile ID" while WelcomeScreen hid it. `hostDouble()` reports Developer
    // Mode OFF, which is the shipped configuration.
    const { rendered } = await renderScreen(<GateProbe />);

    await rendered.press(rendered.pressableWith('probe')!);

    expect(rendered.text()).toContain(OIDC);
    expect(rendered.text()).not.toContain(MDL);

    rendered.unmount();
  });

  it('CONTRACT: mDL stays hidden even with Developer Mode ON', async () => {
    // Developer Mode was the ONLY gate this surface had before the kill switch
    // existed, so a host that turns it on is exactly the case that regressed.
    const host = hostDouble({ getDeveloperMode: () => true });
    const { rendered } = await renderScreen(<GateProbe />, { host });

    await rendered.press(rendered.pressableWith('probe')!);

    expect(rendered.text()).toContain(OIDC);
    expect(rendered.text()).not.toContain(MDL);

    rendered.unmount();
  });
});
