import { useCallback, useRef } from 'react';
import { useSignInGate } from '../components/SignInSheet';

/**
 * Wraps an action that requires authentication. Authenticated users see
 * the action fire immediately; guests see the SignInSheet and the action
 * fires automatically after a successful sign-in (auto-replay).
 *
 * The wrapper has stable identity across renders (it depends only on the
 * gate context, not on the action closure), so passing it as `onPress`
 * does not force child components to re-render every time the parent
 * re-renders. The *latest* action closure is captured via a ref, so the
 * replay always sees the freshest state — no stale-closure bugs the way
 * a plain `useCallback` would have.
 *
 * Example:
 *   const handleVote = useAuthGuardedAction((value: 1 | -1) =>
 *     vote(value, { userVoted: userVote, upvoteCount }),
 *   );
 *   <TouchableOpacity onPress={() => handleVote(1)} />
 */
export function useAuthGuardedAction<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
): (...args: TArgs) => void {
  const gate = useSignInGate();
  // Mirror the latest fn into a ref so the returned callback (which we
  // intentionally memoise on `gate` only) never closes over a stale fn.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  return useCallback(
    (...args: TArgs) => {
      gate.require(() => {
        /*
         * A rejection here used to vanish. `void fn()` drops the promise, so
         * every one of these actions failed in total silence — no bubble, no
         * alert, no log. That is how a broken image picker looked identical to
         * a cancelled one for a whole night of testing: the native module was
         * throwing NoSuchMethodError and nothing on any screen said so.
         *
         * Actions that CAN report their own failure still do; this is the
         * floor, not a replacement. It stays out of the UI on purpose —
         * seventeen call sites already alert where an alert belongs, and
         * adding one here would double them.
         */
        try {
          const ran = fnRef.current(...args);
          if (ran && typeof (ran as Promise<void>).catch === 'function') {
            (ran as Promise<void>).catch((err: unknown) => {
              console.error('[useAuthGuardedAction] action rejected', err);
            });
          }
        } catch (err: unknown) {
          // Threw before returning a promise — a synchronous action, or an
          // async one that failed while evaluating its own arguments.
          console.error('[useAuthGuardedAction] action threw', err);
        }
      });
    },
    [gate],
  );
}
