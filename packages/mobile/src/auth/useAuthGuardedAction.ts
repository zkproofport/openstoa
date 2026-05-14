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
        void fnRef.current(...args);
      });
    },
    [gate],
  );
}
