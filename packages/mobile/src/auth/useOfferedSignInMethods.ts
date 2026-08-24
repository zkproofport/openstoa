import { useMemo } from 'react';
import { useDeveloperMode } from '../hooks/useDeveloperMode';
import {
  offeredSignInMethods,
  type SignInMethod,
} from './signInMethods';

/**
 * `offeredSignInMethods()` with the host's Developer Mode flag already read.
 *
 * Split out of `signInMethods.ts` so that module stays free of React and of the
 * host bridge — a test can assert the offered set without mounting a provider,
 * and a surface that only needs the data does not drag `useHost()` in with it.
 *
 * Re-renders on toggle, because `useDeveloperMode` subscribes to the host's
 * change listener.
 *
 * NOTE: this hook calls `useHost()` underneath, so it only works inside
 * `<HostProvider>`. Surfaces that must render outside one (`WelcomeScreen` is
 * rendered bare in tests) take the list as a prop instead — see
 * `WelcomeScreenProps.methods`.
 */
export function useOfferedSignInMethods(): readonly SignInMethod[] {
  const developerMode = useDeveloperMode();
  return useMemo(
    () => offeredSignInMethods({ developerMode }),
    [developerMode],
  );
}
