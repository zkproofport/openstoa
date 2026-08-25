import React, { createContext, useContext, type ReactNode } from 'react';
import type { SignInMethodId } from './signInMethods';

/**
 * A function that drives the full ZK-proof sign-in flow on the host.
 *
 * Why we expose this as context (vs. having every gate call
 * `host.loginToOpenStoa({force:true})` directly):
 *
 *   The host shows its own `<ProofRequestModal>` mid-flow. iOS cannot
 *   reliably stack a second native `<Modal>` on top of an already-open
 *   `<Modal>` — so if the call originates from inside the SignInSheet
 *   modal, the proof modal lands hidden behind the sheet and the user
 *   never gets to confirm the proof. Polling then runs until the 6-minute
 *   timeout.
 *
 *   By routing all sign-in entry points through this launcher, OpenStoaApp
 *   can switch itself to the `'authenticating'` phase (a plain `BootScreen`
 *   view, NOT a Modal) before the proof flow starts. The proof modal then
 *   has a clean modal slot to mount into.
 *
 *   `onSuccess` is invoked after `session.setSession()` runs, so the
 *   SignInSheet's "auto-replay" queue can fire the original action with
 *   the new auth state.
 */
/**
 * `method` selects the proof flavor:
 *   - `'oidc'` (default) — Google / Microsoft OIDC sign-in
 *   - `'mdl'`            — Korea Mobile ID via OmniOne CX (experimental)
 *
 * The union comes from `signInMethods.ts` rather than being restated here, so
 * the launcher and the offered-methods list cannot drift: adding a method there
 * is immediately a type error in every launcher implementation that does not
 * handle it.
 */
export type SignInLauncher = (
  onSuccess?: () => void,
  method?: SignInMethodId,
  /**
   * End the session on the account's other phone.
   *
   * Left out on the first attempt so the server can refuse and say what it
   * found — the chat keys are on that other phone and do not travel with the
   * account, and the only device that can still back them up is the one signed
   * in at that moment. Passed as true only after the person has read the
   * notice and chosen to continue.
   */
  takeover?: boolean,
) => void;

const SignInLauncherContext = createContext<SignInLauncher | null>(null);

export function SignInLauncherProvider({
  value,
  children,
}: {
  value: SignInLauncher;
  children: ReactNode;
}) {
  return (
    <SignInLauncherContext.Provider value={value}>
      {children}
    </SignInLauncherContext.Provider>
  );
}

export function useSignInLauncher(): SignInLauncher {
  const ctx = useContext(SignInLauncherContext);
  if (!ctx) {
    throw new Error(
      '[openstoa-mobile] useSignInLauncher() called outside SignInLauncherProvider',
    );
  }
  return ctx;
}
