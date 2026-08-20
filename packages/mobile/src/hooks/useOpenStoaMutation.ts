import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';
import { GuestAuthRequiredError } from '../api/openstoaClient';

/**
 * Drop-in replacement for `@tanstack/react-query`'s `useMutation` — import
 * it aliased (`import { useOpenStoaMutation as useMutation } from
 * '../../hooks/useOpenStoaMutation'`) so call sites need no other change.
 *
 * The one difference: when the mutation fails with `GuestAuthRequiredError`,
 * the caller's own `onError` is skipped instead of invoked.
 *
 * Why: that error now ALSO auto-opens the sign-in sheet (see
 * `auth/sessionLifecycle.ts` `onSessionDropped` -> `sessionExpiry.ts` ->
 * `SignInSheetProvider`'s subscription), which already explains what
 * happened and what to do about it. Every screen in this app that reacts to
 * a mutation failure does so with a single-purpose `onError` — either
 * `Alert.alert(title, err.message)` or `host.showError(code, ...)` — so
 * without this, EVERY one of those would ALSO fire, stacking a second,
 * unhelpful "Action failed: Sign-in required for /api/..." box on top of
 * the sheet for the exact same event. Any other error (network, 500,
 * validation, a 403 from a route the caller expected to succeed) reaches
 * `onError` completely unchanged — this is a no-op for every non-auth
 * failure.
 *
 * Deliberately narrow: it only ever skips a call the caller supplied, never
 * adds behaviour of its own, so a mutation whose `onError` does more than
 * alert (optimistic-update rollback, for instance) must NOT be routed
 * through this wrapper — skipping that rollback on this one error would
 * leave the UI showing a state the server never confirmed. Check each call
 * site's `onError` body before aliasing the import.
 */
export function useOpenStoaMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const { onError, ...rest } = options;
  return useMutation<TData, TError, TVariables, TContext>({
    ...rest,
    // Forwarded with `...args` rather than a fixed arity: react-query's
    // `onError` signature has grown a parameter before (onMutateResult was
    // added alongside `context`) and this wrapper's whole job is to be
    // invisible on every path except "skip the call" — hard-coding the
    // parameter count is exactly the kind of thing that silently drops an
    // argument the next dependency bump adds.
    onError: onError
      ? (...args: Parameters<NonNullable<typeof onError>>) => {
          const [err] = args;
          if (err instanceof GuestAuthRequiredError) return undefined;
          return onError(...args);
        }
      : undefined,
  });
}
