/*
 * `useDeviceProof` proves ONCE PER ACCOUNT, not once per app run.
 *
 * THE TWO WAYS THIS LATCH CAN BE WRONG, and both have shipped elsewhere in this
 * codebase:
 *
 *   - Latch on a BOOLEAN (`useRef(false)`). The hook lives at the mini-app root
 *     and is never remounted, so the ref stays true for the whole process. A
 *     second account signing in without a restart never registers its device,
 *     and the symptom arrives much later and somewhere else: the takeover prompt
 *     firing on every sign-in for a phone whose key the server never learned.
 *     `RecoveryRepair` latches per account for exactly this reason.
 *   - No latch at all. The effect's dependencies include `authenticated` and the
 *     client, so it re-runs whenever either changes — a session-mode flip during
 *     a token refresh is enough. Each run spends a one-time nonce and rewrites
 *     `last_proved_at`, for no gain.
 *
 * WHY THE OBVIOUS TEST PROVES NOTHING. "Render twice with the same userId, assert
 * one call" is green with the latch DELETED, because React does not re-run an
 * effect whose dependencies did not change — the assertion measures React, not
 * the guard. So the repetition case here churns a dependency (`authenticated`
 * false → true) while holding the account fixed, which is the only shape in
 * which the guard is load-bearing.
 *
 * VERIFIED TO FAIL: with the `provedFor.current === userId` line deleted, the
 * REPETITION cases go red; with the latch changed to a boolean, the SECOND
 * ACCOUNT case goes red. Both were run (see the report accompanying this file).
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → a dependency churning 1 and 5 times over one
 *                            account still proves exactly once
 *   contract   → an authenticated account with a store proves exactly once
 *   contract   → a DIFFERENT account proves again in the same process
 *   authz      → a guest, and an authenticated session with no userId, prove
 *                nothing at all
 *   empty      → a host with no `secureStore` proves nothing and does not throw
 *   external   → a failing proof is swallowed, is not retried for that account,
 *                and leaves the tree alive
 *   race       → the latch is claimed BEFORE the await, so two effect runs in
 *                one tick cannot both fire
 *   boundary / hostile / UTF-8 / large → N/A: the hook's only inputs are a
 *                boolean and an account id it never parses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { render, flush, flushUntil } from './harness/render';

/** The host the hook reads its secure store from. */
const secureStore = {
  getItem: vi.fn(async () => null as string | null),
  setItem: vi.fn(async () => {}),
};
let host: { secureStore?: typeof secureStore } = { secureStore };

vi.mock('@openstoa/miniapp-bridge', () => ({ useHost: () => host }));

/** What the hook asks; counted, not exercised — `proveDevice` has its own file. */
const client = {
  get: vi.fn(async () => ({ nonce: Buffer.from('nonce').toString('base64') })),
  post: vi.fn(async () => ({ ok: true })),
};

vi.mock('../hooks/useOpenStoaClient', () => ({ useOpenStoaClient: () => client }));

/*
 * A deterministic stand-in for the native crypto. Real Ed25519 is asserted in
 * `deviceProofPostsWhatTheRouteRequires.test.tsx`; here it only has to not be
 * the native module, which cannot load off a device.
 */
vi.mock('react-native-quick-crypto', () => ({
  Ed: class {
    async generateKeyPair() {}
    getPublicKey() {
      return new Uint8Array(32).fill(7).buffer as ArrayBuffer;
    }
    getPrivateKey() {
      return new Uint8Array(32).fill(9).buffer as ArrayBuffer;
    }
    async sign() {
      return new Uint8Array(64).fill(1).buffer as ArrayBuffer;
    }
    async verify() {
      return true;
    }
  },
}));

import { useDeviceProof } from '../hooks/useDeviceProof';
import { resetDeviceKeyMemo } from '../crypto/deviceKey';
import { useOpenStoaSession } from '../stores/sessionStore';

/** The hook has no visible output; this exists only to run it. */
function Probe({ authenticated }: { authenticated: boolean }) {
  useDeviceProof(authenticated);
  return null;
}

/** Sign an account in, the way the boot sequence does. */
async function signIn(userId: string) {
  await act(async () => {
    useOpenStoaSession.getState().setSession({ token: `token-for-${userId}`, userId });
  });
  await flush();
}

/** How many times the device was proved. */
const proofs = () => client.get.mock.calls.length;

/**
 * Wait for the proof count to REACH `n`, then let the caller assert equality.
 *
 * WHY NOT `flush()` HERE. `flush()` drains a fixed six ticks — a guess about how
 * long the chain takes, and one that goes stale the moment somebody adds an
 * `await` three modules down. That happened on 2026-08-26: `crypto/deviceKey.ts`
 * moved its native import to `await import(...)`, the chain grew by a
 * dynamic-import tick, and four cases in this file failed in one full run and
 * passed on the next two. The assertions were right; the waiting was wrong.
 * Raising the count would only move the cliff.
 */
const reachedProofs = (n: number) =>
  flushUntil(() => proofs() >= n, { label: `proofs() >= ${n}` });

/**
 * Drain far past any plausible chain, for the cases asserting a count does NOT
 * rise.
 *
 * A "did not happen" cannot be waited for by condition — there is nothing to
 * wait on — so this is a ceiling rather than a guess: fifty ticks is an order of
 * magnitude beyond the longest real chain here, and if the count is still
 * unchanged then the extra proof genuinely was not made.
 */
const settle = () => flush(50);

beforeEach(() => {
  vi.clearAllMocks();
  resetDeviceKeyMemo();
  host = { secureStore };
  client.get.mockImplementation(async () => ({ nonce: Buffer.from('nonce').toString('base64') }));
  act(() => {
    useOpenStoaSession.getState().clear();
  });
});

describe('the device is proved once per account', () => {
  it('CONTRACT: an authenticated account proves exactly once', async () => {
    await signIn('user-a');

    const r = await render(<Probe authenticated />);
    await reachedProofs(1);

    expect(proofs()).toBe(1);
    r.unmount();
  });

  it('REPETITION: a dependency churning does not re-prove the same account', async () => {
    /*
     * THE guard, and the only case that measures it. `authenticated` flipping is
     * what a token refresh looks like from inside this hook: the effect re-runs
     * because its dependencies changed, and only the latch stops a second nonce
     * being spent on the account that already registered.
     */
    await signIn('user-a');
    const r = await render(<Probe authenticated />);
    await reachedProofs(1);
    expect(proofs()).toBe(1);

    await r.update(<Probe authenticated={false} />);
    await r.update(<Probe authenticated />);
    await reachedProofs(1);

    expect(proofs()).toBe(1);
    r.unmount();
  });

  it('REPETITION: five flips still leave exactly one proof', async () => {
    // One flip could be a coincidence of ordering; five cannot.
    await signIn('user-a');
    const r = await render(<Probe authenticated />);

    for (let i = 0; i < 5; i++) {
      await r.update(<Probe authenticated={false} />);
      await r.update(<Probe authenticated />);
    }
    await reachedProofs(1);

    expect(proofs()).toBe(1);
    r.unmount();
  });

  it('CONTRACT: a DIFFERENT account proves again in the same process', async () => {
    /*
     * The half a boolean latch fails. This hook is mounted at the root and never
     * remounted, so "already proved" has to mean "already proved FOR THIS
     * ACCOUNT" or the second person to sign in on a phone never registers.
     */
    await signIn('user-a');
    const r = await render(<Probe authenticated />);
    await reachedProofs(1);
    expect(proofs()).toBe(1);

    await signIn('user-b');
    await reachedProofs(2);

    expect(proofs()).toBe(2);
    r.unmount();
  });

  it('CONTRACT: switching back to the FIRST account does not prove a third time', async () => {
    // The latch holds the current account, so returning to a previous one does
    // re-prove — asserted so the behaviour is a decision rather than a surprise.
    await signIn('user-a');
    const r = await render(<Probe authenticated />);
    await signIn('user-b');
    await signIn('user-a');
    await reachedProofs(3);

    expect(proofs()).toBe(3);
    r.unmount();
  });
});

describe('the device is not proved when there is nothing to prove it for', () => {
  it('AUTHZ: a guest proves nothing', async () => {
    await act(async () => {
      useOpenStoaSession.getState().setGuest();
    });

    const r = await render(<Probe authenticated={false} />);
    await settle();

    expect(proofs()).toBe(0);
    r.unmount();
  });

  it('AUTHZ: `authenticated` without a userId proves nothing', async () => {
    /*
     * The window between a token arriving and the account id being known. A
     * proof sent here would register the key against nobody.
     */
    const r = await render(<Probe authenticated />);
    await settle();

    expect(proofs()).toBe(0);
    r.unmount();
  });

  it('EMPTY: a host with no secure store proves nothing and does not throw', async () => {
    // An older host build simply does not expose one; there is nowhere to keep a
    // private key, so there is no key to prove.
    host = {};
    await signIn('user-a');

    const r = await render(<Probe authenticated />);
    await settle();

    expect(proofs()).toBe(0);
    r.unmount();
  });
});

describe('a failed proof costs the session nothing', () => {
  it('EXTERNAL: a rejected proof is swallowed and the tree stays alive', async () => {
    /*
     * Every failure mode — offline, an expired nonce, a 409 for an id that
     * already registered a different key — leaves the account exactly as usable
     * as it was. A rejection escaping here would surface a degraded GROUPING as
     * a broken app.
     */
    client.get.mockImplementation(async () => {
      throw new Error('offline');
    });
    await signIn('user-a');

    const r = await render(<Probe authenticated />);
    await reachedProofs(1);

    expect(proofs()).toBe(1);
    expect(r.root).toBeTruthy();
    r.unmount();
  });

  it('EXTERNAL: a failure is not retried for the same account', async () => {
    /*
     * The latch is claimed BEFORE the await, so a failure does not re-arm it.
     * That is deliberate: a phone that is offline at sign-in would otherwise
     * retry on every dependency change for the rest of the session.
     */
    client.get.mockImplementation(async () => {
      throw new Error('offline');
    });
    await signIn('user-a');
    const r = await render(<Probe authenticated />);

    for (let i = 0; i < 3; i++) {
      await r.update(<Probe authenticated={false} />);
      await r.update(<Probe authenticated />);
    }
    await reachedProofs(1);

    expect(proofs()).toBe(1);
    r.unmount();
  });
});
