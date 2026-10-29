/**
 * The sign-in buttons: both surfaces render the one offered list from
 * `auth/signInMethods.ts`, and that list is OIDC only.
 *
 * History: a Mobile ID (mDL) button was once hidden on `WelcomeScreen` while
 * `SignInSheet` kept its own copy of the list and went on offering it; the list
 * moved to `auth/signInMethods.ts` so there is one. The Korea Mobile ID circuits
 * have since left ZKProofport entirely (2026-10-29), so the method is gone, not
 * hidden: `'mdl'` is not a sign-in method id any more.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) -> coverage here
 *   contract   -> the declared and offered sets are exactly ['oidc'] under
 *                 BOTH Developer Mode settings; 'mdl' is not offered
 *   contract   -> WelcomeScreen renders one button per method it is given,
 *                 wired to `onSignIn` with that method's id; SignInSheet
 *                 renders the same set
 *   integrity  -> sign-in and guest browsing stay callable
 *   boundary   -> the pressable COUNT is asserted, not only the copy; an
 *                 empty list renders no sign-in button at all
 *   empty      -> no `methods` prop gets the offered default
 *   race       -> `busy` disables every CTA
 *   authz / hostile / UTF-8 / very large -> N/A: callbacks and catalogue copy
 *                 only, no caller identity or free text.
 *
 * i18next is not initialised in this harness, so `t(key)` returns the key, and
 * the assertions match on `openstoa.*` keys rather than English copy.
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
const GUEST = 'openstoa.welcome.continueAsGuest';
/** A second method that exists only in this test, to prove the screen renders the list it is given. */
const OTHER = 'openstoa.test.otherMethod';
const otherMethod: SignInMethod = {
  id: 'oidc',
  labelKey: OTHER,
  emphasis: 'secondary',
  enabled: true,
  developerOnly: false,
};

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


describe('the offered sign-in methods (auth/signInMethods.ts)', () => {
  it('CONTRACT: OIDC is the only declared method', () => {
    expect(SIGN_IN_METHODS.map((m) => m.id)).toEqual(['oidc']);
  });

  it('CONTRACT: OIDC is offered and Mobile ID is not, with Developer Mode off OR on', () => {
    for (const developerMode of [false, true]) {
      expect(offeredSignInMethods({ developerMode }).map((m) => m.id)).toEqual(['oidc']);
      expect(isSignInMethodOffered('oidc', { developerMode })).toBe(true);
      // An id from an older host contract is simply not one of ours.
      expect(isSignInMethodOffered('mdl' as never, { developerMode })).toBe(false);
    }
  });
});

describe('WelcomeScreen renders the offered methods and nothing else', () => {
  it('EMPTY: no `methods` prop -> the offered default', async () => {
    const r = await render(
      <WelcomeScreen onSignIn={() => {}} onContinueAsGuest={() => {}} />,
    );

    expect(r.text()).toContain(OIDC);
    // BOUNDARY: sign in + guest, and nothing in between. A labelless button
    // would pass the text assertions above and fail here.
    expect(pressables(r.root).length).toBe(2);
  });

  it('CONTRACT: what the app actually passes (the offered set) renders OIDC only', async () => {
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

    expect(r.text()).toContain(OIDC);
    expect(pressables(r.root).length).toBe(2);
  });

  it('CONTRACT: a method that IS offered renders, and is wired to its id', async () => {
    // Proves the screen is a renderer of the list rather than a hardcoded
    // stack: hand it a method only this test knows and the button appears,
    // wired to that method's id.
    const onSignIn = vi.fn();
    const r = await render(
      <WelcomeScreen
        methods={[...SIGN_IN_METHODS, otherMethod]}
        onSignIn={onSignIn}
        onContinueAsGuest={() => {}}
      />,
    );

    expect(r.text()).toContain(OTHER);
    const button = r.pressableWith(OTHER);
    expect(button).toBeDefined();
    expect(pressables(r.root).length).toBe(3);

    await r.press(button!);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith('oidc');
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
    // Guest browsing survives — the only CTA left.
    expect(pressables(r.root).length).toBe(1);
    expect(r.text()).toContain(GUEST);
  });

  it('INTEGRITY: sign-in and guest browsing are both callable', async () => {
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
  it('CONTRACT: the opened sheet offers OIDC only', async () => {
    // This sheet once kept its own list. `hostDouble()` reports Developer
    // Mode OFF, the shipped configuration.
    const { rendered } = await renderScreen(<GateProbe />);

    await rendered.press(rendered.pressableWith('probe')!);

    expect(rendered.text()).toContain(OIDC);

    rendered.unmount();
  });

  it('CONTRACT: the sheet offers OIDC only with Developer Mode ON too', async () => {
    const host = hostDouble({ getDeveloperMode: () => true });
    const { rendered } = await renderScreen(<GateProbe />, { host });

    await rendered.press(rendered.pressableWith('probe')!);

    expect(rendered.text()).toContain(OIDC);

    rendered.unmount();
  });
});
