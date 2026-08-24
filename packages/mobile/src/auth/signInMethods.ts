/**
 * The one place that decides WHICH sign-in methods this build offers.
 *
 * There are two sign-in surfaces and there will stay two — they are not
 * redundant. `WelcomeScreen` is the full-screen first-run entry, with the
 * onboarding heading, the bullets and "continue as guest". `SignInSheet` is a
 * compact interruption raised mid-flow when a guest hits a gated action, or
 * unprompted when the server refuses an expired session; it has "Not now" and
 * its own session-expired copy. Neither can stand in for the other.
 *
 * What was duplicated was not the chrome — it was the LIST. Each surface built
 * its own button stack out of its own translation keys and its own handler per
 * method, so "offer this method" was two edits and "stop offering it" was two
 * edits too. It was done as one: mDL was hidden for the 1.0.0 corporate beta on
 * `WelcomeScreen` only, and the sheet kept showing "Sign in with Mobile ID" to
 * anyone a gate interrupted. A tester found it on production-shaped staging.
 *
 * So the list lives here, once, as data:
 *
 *   - `enabled` is the release kill switch. `false` means this build does not
 *     offer the method AT ALL, on any surface, whatever the host says.
 *   - `developerOnly` means "offered only when the host has Developer Mode on"
 *     — the pre-existing gate for host-experimental paths, unchanged.
 *   - `labelKey` is the SHARED translation key. Both surfaces render the same
 *     string for the same method; only the surrounding copy differs.
 *   - `id` is what gets handed to `SignInLauncher` — the surfaces no longer
 *     each carry a per-method handler, they carry one `(id) => launch(id)`.
 *
 * Deliberately free of React and of the host bridge, so the offered set can be
 * asserted directly by a test without mounting anything. `offeredSignInMethods`
 * is the function every surface goes through; the Developer Mode read is the
 * hook next door in `useOfferedSignInMethods.ts`.
 *
 * ADDING A METHOD: append one entry below, add its `labelKey` to en.json AND
 * ko.json, and teach `SignInLauncher`'s `method` union the new id. Both surfaces
 * pick it up with no edit — that is the whole point of this file.
 */

/**
 * Proof flavour handed to `SignInLauncher`.
 *
 * Kept identical to `SignInLauncher`'s own `method` parameter — see
 * `SignInLauncher.tsx`, which imports this type rather than restating it, so
 * the two can never drift apart.
 */
export type SignInMethodId = 'oidc' | 'mdl';

export interface SignInMethod {
  /** Passed straight to the launcher to select the proof flavour. */
  id: SignInMethodId;
  /** Shared i18n key for the button label — same string on every surface. */
  labelKey: string;
  /**
   * Visual weight. Exactly one method is `'primary'` (filled); the rest render
   * outlined. This is the only styling fact that belongs to the METHOD rather
   * than to the surface — sizes, spacing and colours stay with each surface.
   */
  emphasis: 'primary' | 'secondary';
  /**
   * `false` = this build does not offer the method at all. Release kill switch;
   * outranks `developerOnly`.
   */
  enabled: boolean;
  /** `true` = offered only when the host has Developer Mode enabled. */
  developerOnly: boolean;
}

/**
 * Every sign-in method the mini-app knows how to start, in display order.
 *
 * `mDL` is `enabled: false` for the 1.0.0 corporate beta (Masse Labs): the
 * Korea Mobile ID path is still host-experimental and out of scope for that
 * release, and shipping a half-finished second sign-in path — even behind
 * Developer Mode — is a support burden on a build going to outside testers.
 * Nothing is deleted: the launcher argument, the copy and the translations all
 * still exist. TO RESTORE: set `enabled: true`. The button then reappears under
 * Developer Mode, on BOTH surfaces, exactly as it did before.
 */
export const SIGN_IN_METHODS: readonly SignInMethod[] = Object.freeze([
  Object.freeze({
    id: 'oidc',
    labelKey: 'openstoa.signIn.method.oidc',
    emphasis: 'primary',
    enabled: true,
    developerOnly: false,
  }),
  Object.freeze({
    id: 'mdl',
    labelKey: 'openstoa.signIn.method.mdl',
    emphasis: 'secondary',
    // Hidden for the 1.0.0 corporate beta — see the block comment above.
    enabled: false,
    developerOnly: true,
  }),
]) as readonly SignInMethod[];

export interface SignInMethodContext {
  /** The host's Developer Mode flag — `useDeveloperMode()` on a device. */
  developerMode: boolean;
}

/**
 * The rule, for one method: shipped at all, and past the Developer Mode gate
 * if it has one.
 *
 * Exported so a test can apply the REAL rule to a hypothetical method — e.g.
 * "if mDL's `enabled` were flipped back, would it be offered?" — without
 * reimplementing the condition. A test that restates the rule agrees with
 * itself no matter what this file does, which is the one thing a guard on this
 * file must not be.
 */
export function methodIsOffered(
  method: SignInMethod,
  context: SignInMethodContext,
): boolean {
  return method.enabled && (!method.developerOnly || context.developerMode);
}

/**
 * The methods this build offers right now, in display order.
 *
 * Every sign-in surface renders THIS and nothing else. A method missing here is
 * unreachable: there is no per-surface list left to fall out of sync with.
 */
export function offeredSignInMethods(
  context: SignInMethodContext,
): readonly SignInMethod[] {
  return SIGN_IN_METHODS.filter((method) => methodIsOffered(method, context));
}

/** Whether one specific method is offered — the same rule, asked pointwise. */
export function isSignInMethodOffered(
  id: SignInMethodId,
  context: SignInMethodContext,
): boolean {
  return offeredSignInMethods(context).some((method) => method.id === id);
}
