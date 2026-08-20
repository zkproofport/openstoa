/**
 * `useOpenStoaMutation` is the drop-in `useMutation` replacement that skips
 * a mutation's OWN `onError` when the failure is `GuestAuthRequiredError` —
 * that error now auto-opens the sign-in sheet (sessionLifecycle.ts ->
 * sessionExpiry.ts -> SignInSheetProvider), so the screen's own generic
 * "Action failed: Sign-in required for /api/..." alert would otherwise
 * stack a second, unhelpful prompt on top of it for the same event.
 *
 * Matrix rows covered:
 *   contract  — GuestAuthRequiredError skips the caller's onError
 *   contract  — any OTHER error (plain Error) still reaches onError,
 *               unchanged, with the same (error, variables, context) args
 *   boundary  — no onError supplied at all does not throw wiring the hook
 *   integrity — onSuccess still fires normally for a successful mutation
 *               (this wrapper touches ONLY the error path)
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from './harness/render';
import { useOpenStoaMutation } from '../hooks/useOpenStoaMutation';
import { GuestAuthRequiredError } from '../api/openstoaClient';

function Harness({
  run,
  onError,
  onSuccess,
}: {
  run: () => Promise<string>;
  onError?: (err: unknown, variables: void, context: unknown) => void;
  onSuccess?: (data: string) => void;
}) {
  const mutation = useOpenStoaMutation<string, unknown, void, unknown>({
    mutationFn: run,
    onError,
    onSuccess,
  });
  return (
    <TouchableOpacity onPress={() => mutation.mutate()}>
      <Text>trigger</Text>
    </TouchableOpacity>
  );
}

function wrap(el: React.ReactElement) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{el}</QueryClientProvider>;
}

describe('useOpenStoaMutation', () => {
  it('skips the caller onError when the mutation fails with GuestAuthRequiredError', async () => {
    const onError = vi.fn();
    const rendered = await render(
      wrap(
        <Harness
          run={async () => {
            throw new GuestAuthRequiredError('/api/topics');
          }}
          onError={onError}
        />,
      ),
    );
    await rendered.press(rendered.pressableWith('trigger')!);
    expect(onError).not.toHaveBeenCalled();
  });

  it('still calls the caller onError, with the original arguments, for any other error', async () => {
    const onError = vi.fn();
    const boom = new Error('network down');
    const rendered = await render(
      wrap(
        <Harness
          run={async () => {
            throw boom;
          }}
          onError={onError}
        />,
      ),
    );
    await rendered.press(rendered.pressableWith('trigger')!);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
  });

  it('does not throw when constructed with no onError at all, even on a GuestAuthRequiredError failure', async () => {
    const rendered = await render(
      wrap(
        <Harness
          run={async () => {
            throw new GuestAuthRequiredError('/api/topics/x/posts');
          }}
        />,
      ),
    );
    // The assertion IS that pressing this does not throw / reject unhandled.
    await expect(rendered.press(rendered.pressableWith('trigger')!)).resolves.toBeUndefined();
  });

  it('onSuccess still fires normally — the wrapper only touches the error path', async () => {
    const onSuccess = vi.fn();
    const rendered = await render(
      wrap(<Harness run={async () => 'ok'} onSuccess={onSuccess} />),
    );
    await rendered.press(rendered.pressableWith('trigger')!);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // First two args are the ones this wrapper could plausibly disturb
    // (it destructures/forwards `onError` only, but assert the success
    // path is untouched end to end). The exact shape of a 3rd/4th arg is
    // react-query's own contract, not this wrapper's — not asserted here.
    expect(onSuccess.mock.calls[0][0]).toBe('ok');
    expect(onSuccess.mock.calls[0][1]).toBeUndefined();
  });
});
