import { useCallback, useEffect, useState } from 'react';
import { useOpenStoaClient } from './useOpenStoaClient';

/**
 * The Bearer to put on an image request, as React state.
 *
 * Why state and not `await client.mediaAuthToken()` at each render site:
 * two of the three consumers cannot await anything. `provideEmbeddedHeaders`
 * (`PostContent`) is a SYNCHRONOUS callback `react-native-render-html` calls
 * while building an image's source, and a `FlatList` row's `<Image>` must be
 * able to mount on its first render rather than after a promise settles —
 * `docs/design/gated-image-credentials.md` calls out both, and the "hoist the
 * resolved token into React state once and read it synchronously" shape is the
 * conclusion it reaches.
 *
 * The seed is what makes that cheap. `peekAuthToken()` answers from the
 * client's in-memory cache with no await at all, and by the time any image
 * mounts the query that produced the post has already populated it — so the
 * usual case is "first render already has the token" and the effect below
 * never fires. It fires on a genuinely cold start, where every mounted
 * consumer resolves the same cached value; that is a burst of identical
 * `tryGetToken()` calls exactly once, not per scroll.
 *
 * A guest holds `null` here for the app's lifetime, which is correct: the
 * media route serves public-topic images and avatars without a session, and
 * refuses the rest to a caller who has nothing to prove membership with.
 */
export interface MediaAuthToken {
  /** The current Bearer, or null for a guest / an unresolvable session. */
  token: string | null;
  /**
   * Ask the client for the token again.
   *
   * The one case this covers: an image mounted during the window where the
   * cached token had expired and the client's refresh had not landed yet. That
   * request 401s, and React Native does not retry an `<Image>` just because
   * unrelated state changed later — so the failure is permanent for that row
   * until something re-resolves. Wired to `onError` in `GatedImage`.
   *
   * Deliberately NOT a forced re-login: `mediaAuthToken()` refreshes silently
   * when the token is near expiry and otherwise hands back what it has. An
   * image that failed must never be the thing that pops a sign-in prompt.
   */
  reresolve: () => void;
}

export function useMediaAuthToken(): MediaAuthToken {
  const client = useOpenStoaClient();
  const [token, setToken] = useState<string | null>(() => client.peekAuthToken());

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    void client
      .mediaAuthToken()
      .then((next) => {
        // `next &&` — resolving to null (a guest) must not schedule a state
        // update, or this effect re-runs itself forever on its own `token`
        // dependency.
        if (!cancelled && next) setToken(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const reresolve = useCallback(() => {
    void client
      .mediaAuthToken()
      .then((next) => {
        if (next) setToken((prev) => (prev === next ? prev : next));
      })
      .catch(() => undefined);
  }, [client]);

  return { token, reresolve };
}
