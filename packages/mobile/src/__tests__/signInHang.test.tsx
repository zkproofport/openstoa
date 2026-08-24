/**
 * The sign-in screen must not be a trap.
 *
 * A real device hung on "Preparing your anonymous identity…" and stayed there
 * until the app was force-quit. Nothing had failed — `performSignIn` awaited
 * `host.loginToOpenStoa` inside a `try/catch`, and the promise simply never
 * settled. A `catch` cannot catch that: there is no rejection, only a caller
 * that never resumes. `phase` stayed `'authenticating'`, the screen it renders
 * had no control on it, and `signInInflightRef` stayed `true` — so even if the
 * person had reached Welcome some other way, every retry would have returned at
 * the guard on the first line of `performSignIn` and done nothing.
 *
 * These tests are about that shape specifically: not "login failed", which was
 * always handled, but "login never answered", which was not.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   boundary   → a login that resolves inside the deadline still reaches the
 *                app; one that never resolves is abandoned AT the deadline and
 *                not one tick before it; the Cancel control appears at its own
 *                (much shorter) deadline and not before
 *   race       → a login that comes back AFTER the user gave up is discarded —
 *                it must not drag them into the app they walked away from, nor
 *                release the guard belonging to a retry already in flight
 *   contract   → `host.loginToOpenStoa` is called again on retry, which is the
 *                only proof that `signInInflightRef` was released; the count is
 *                asserted, not just the resulting screen
 *   integrity  → the reason is SHOWN on Welcome, and a timeout says something
 *                different from a failure — the user learns the server did not
 *                answer rather than "something went wrong"
 *   empty      → cancelling reports no error text at all: the person did it on
 *                purpose and does not need to be told off for it
 *   authz      → N/A here: this is the pre-auth phase machine, which has one
 *                identity (nobody) until the login it is waiting on returns.
 *                Guest is covered by the existing session/auth suites
 *   hostile / UTF-8 / very large → N/A: no free text reaches this component;
 *                its inputs are two button presses and one host promise
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { HostProvider } from '@openstoa/miniapp-bridge';
import type { AuthResult } from '@openstoa/miniapp-bridge';
import { render, flush, type Rendered } from './harness/render';
import { hostDouble } from './harness/screen';

/*
 * The two things that only render once the app is READY are stubbed, and
 * nothing else is.
 *
 * Not for isolation — for reachability. `OpenStoaTabNavigator` pulls
 * `@react-navigation/bottom-tabs`, which is a peer dependency this package does
 * not install, so importing it here fails at resolution before a single
 * assertion runs. What the tests below actually need from it is one bit: did we
 * land in the app or not. `RecoveryRepairProvider` goes for the plainer reason
 * that it starts an account-level key repair the moment it mounts, which has
 * nothing to do with the phase machine and would put unrelated fetches in the
 * way. It is stubbed as a pass-through rather than as `null` — it WRAPS the
 * navigator, so returning null here would delete the "did we land in the app"
 * signal these tests read.
 *
 * Everything the tests DO exercise — the phase machine, the deadline, the
 * cancel control, the guard, the boot sequence — is the real code.
 */
vi.mock('../navigation/OpenStoaTabNavigator', () => ({
  OpenStoaTabNavigator: () => 'READY_TAB_NAVIGATOR',
}));
vi.mock('../components/RecoveryRepair', () => ({
  RecoveryRepairProvider: ({ children }: { children?: unknown }) => children,
}));
/*
 * `src/i18n` registers the mini-app's bundles into the DEFAULT i18next
 * instance, which on a device the host has already initialised. Nothing
 * initialises it here, so the import throws at module load. Stubbed to nothing:
 * with no instance, `t(key)` returns the key, which is what the assertions
 * below match on anyway — and matching on keys rather than English copy is what
 * keeps them alive through a wording change.
 */
vi.mock('../i18n', () => ({}));

import { OpenStoaApp } from '../OpenStoaApp';
import { useOpenStoaSession } from '../stores/sessionStore';

/** Mirrors `BOOT_MIN_DURATION_MS` in OpenStoaApp. */
const BOOT_MS = 3_000;
/** Mirrors `SIGN_IN_CANCEL_VISIBLE_AFTER_MS` in OpenStoaApp. */
const CANCEL_AFTER_MS = 8_000;
/** Mirrors `SIGN_IN_HARD_DEADLINE_MS` in OpenStoaApp. */
const DEADLINE_MS = 8 * 60 * 1000;

// i18next is not initialised in this harness, so `t(key)` hands back the key.
// Asserting on keys rather than on English copy keeps these tests alive through
// a wording change — the same choice `welcomeMdlButton.test.tsx` makes.
const WELCOME = 'openstoa.welcome.heading';
// The sign-in button's label is shared by every sign-in surface now, so it
// lives under `openstoa.signIn.method.*` rather than under this screen's own
// namespace — see `auth/signInMethods.ts`.
const SIGN_IN = 'openstoa.signIn.method.oidc';
const PREPARING = 'openstoa.boot.preparingIdentity';
const CANCEL = 'openstoa.boot.cancelSignIn';
const TIMED_OUT = 'openstoa.welcome.signInTimedOut';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const AUTH: AuthResult = { token: 'jwt.after.login', userId: 'nullifier-1', needsNickname: false };

/** Advance the clock and let everything it woke up settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

interface Booted {
  rendered: Rendered;
  login: ReturnType<typeof vi.fn>;
}

/**
 * Mount the app with NO stored token and walk it through boot to Welcome.
 *
 * `login` is the host's `loginToOpenStoa`; each test supplies what it should do.
 */
async function bootToWelcome(login: ReturnType<typeof vi.fn>): Promise<Booted> {
  const host = hostDouble({
    // No token → boot lands on Welcome, which is where a sign-in starts.
    getOpenStoaToken: async () => null,
    loginToOpenStoa: login,
  });
  const rendered = await render(
    <HostProvider api={host.api as never}>
      <OpenStoaApp />
    </HostProvider>,
  );
  // Boot holds the screen for a fixed beat before it will move anywhere.
  await advance(BOOT_MS + 100);
  expect(rendered.text()).toContain(WELCOME);
  return { rendered, login };
}

async function pressSignIn(rendered: Rendered): Promise<void> {
  const cta = rendered.pressableWith(SIGN_IN);
  expect(cta).toBeDefined();
  await rendered.press(cta!);
}

describe('sign-in cannot strand the app on the boot screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useOpenStoaSession.getState().clear();
    // Boot prefetches the feed and the session; neither is what these tests are
    // about, and both must answer so the phase machine is what is being timed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ posts: [], userId: 'nullifier-1' }),
        text: async () => '{}',
      })) as unknown as typeof fetch,
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('BOUNDARY: a login that never settles is abandoned at the deadline, not before', async () => {
    // The incident, reproduced: a promise that neither resolves nor rejects.
    const login = vi.fn(() => new Promise<AuthResult>(() => {}));
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    expect(rendered.text()).toContain(PREPARING);

    // One tick short of the deadline it is STILL waiting — a deadline that
    // fired early would cancel logins that were going to succeed.
    await advance(DEADLINE_MS - 1);
    expect(rendered.text()).toContain(PREPARING);
    expect(rendered.text()).not.toContain(WELCOME);

    await advance(2);

    // Out of the trap, with the reason on screen.
    expect(rendered.text()).toContain(WELCOME);
    expect(rendered.text()).not.toContain(PREPARING);
    expect(rendered.text()).toContain(TIMED_OUT);
  });

  it('CONTRACT: after a timeout the guard is released, so a retry actually runs', async () => {
    // The half of the bug that outlived the hang: `signInInflightRef` was only
    // cleared in a `finally` that a never-settling promise never reaches, so
    // every later attempt returned at the guard and did nothing at all.
    const never = new Promise<AuthResult>(() => {});
    const login = vi
      .fn()
      .mockReturnValueOnce(never)
      .mockResolvedValueOnce(AUTH);
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    await advance(DEADLINE_MS + 1);
    expect(rendered.text()).toContain(WELCOME);
    expect(login).toHaveBeenCalledTimes(1);

    // The retry: it must reach the host, not stop at the guard.
    await pressSignIn(rendered);
    await advance(10);
    expect(login).toHaveBeenCalledTimes(2);
    expect(rendered.text()).toContain('READY_TAB_NAVIGATOR');
  });

  it('a way out appears while waiting, and taking it returns to Welcome', async () => {
    const login = vi.fn(() => new Promise<AuthResult>(() => {}));
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);

    // BOUNDARY: not immediately. A control that flashes past on the fast path
    // reads as a glitch and invites a tap that aborts a healthy login.
    expect(rendered.pressableWith(CANCEL)).toBeUndefined();

    await advance(CANCEL_AFTER_MS + 1);
    const cancel = rendered.pressableWith(CANCEL);
    expect(cancel).toBeDefined();

    await rendered.press(cancel!);

    expect(rendered.text()).toContain(WELCOME);
    // EMPTY: cancelling is deliberate, so there is nothing to report about it.
    expect(rendered.text()).not.toContain(TIMED_OUT);
  });

  it('CONTRACT: cancelling releases the guard too — the next attempt runs', async () => {
    const login = vi
      .fn()
      .mockReturnValueOnce(new Promise<AuthResult>(() => {}))
      .mockResolvedValueOnce(AUTH);
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    await advance(CANCEL_AFTER_MS + 1);
    await rendered.press(rendered.pressableWith(CANCEL)!);

    await pressSignIn(rendered);
    await advance(10);
    expect(login).toHaveBeenCalledTimes(2);
    expect(rendered.text()).toContain('READY_TAB_NAVIGATOR');
  });

  it('RACE: a login that comes back after the user gave up is discarded', async () => {
    const late = deferred<AuthResult>();
    const login = vi.fn(() => late.promise);
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    await advance(CANCEL_AFTER_MS + 1);
    await rendered.press(rendered.pressableWith(CANCEL)!);
    expect(rendered.text()).toContain(WELCOME);

    // The host finally answers. The person is not on that screen any more and
    // must not be thrown into the app they walked away from.
    await act(async () => {
      late.resolve(AUTH);
    });
    await advance(10);

    expect(rendered.text()).toContain(WELCOME);
    expect(rendered.text()).not.toContain('READY_TAB_NAVIGATOR');
    expect(useOpenStoaSession.getState().mode).not.toBe('authenticated');
  });

  it('INTEGRITY: the ordinary fast login is untouched by any of this', async () => {
    const login = vi.fn(async () => AUTH);
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    await advance(10);

    expect(rendered.text()).toContain('READY_TAB_NAVIGATOR');
    expect(useOpenStoaSession.getState().mode).toBe('authenticated');
  });

  it('a login that REJECTS still reports its own reason, not the timeout copy', async () => {
    const login = vi.fn(async () => {
      throw new Error('relay refused the proof');
    });
    const { rendered } = await bootToWelcome(login);

    await pressSignIn(rendered);
    await advance(10);

    expect(rendered.text()).toContain(WELCOME);
    expect(rendered.text()).toContain('relay refused the proof');
    expect(rendered.text()).not.toContain(TIMED_OUT);
  });
});
