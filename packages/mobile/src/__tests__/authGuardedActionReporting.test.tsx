/**
 * An auth-guarded action that fails says so somewhere.
 *
 * `useAuthGuardedAction` used to run its action as `void fn(...args)`. A
 * floating promise: every rejection from all seventeen call sites — voting,
 * posting, attaching a photo — vanished with no bubble, no alert and no log.
 *
 * That is not theoretical. On 2026-08-25 the mini-app's image attach was
 * completely broken on Android (`expo-image-picker` was resolved from the SDK
 * 55 line against an SDK 54 core, so the native call died with
 * `NoSuchMethodError` and the picker's promise REJECTED). On screen it was
 * indistinguishable from the user changing their mind: picker closes, nothing
 * happens. Hours went into telling those two apart by hand because no layer
 * wrote the reason down.
 *
 * So the assertion here is about the FLOOR — a failure leaves a trace — not
 * about any particular UI. Screens that can report their own failure still do;
 * this is what happens when they cannot.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract    → a rejecting async action IS reported (the silent path is the
 *                 regression, so its absence is the assertion)
 *   contract    → a synchronous throw is reported too — it never becomes a
 *                 promise, so the `.catch` alone would miss it
 *   integrity   → the ORIGINAL error object reaches the report, not a
 *                 stringified or shortened copy (CLAUDE.md: never truncate)
 *   hostile     → rejection values that are not Errors — string, null,
 *                 undefined, an object with a throwing `toString` — are still
 *                 reported and never crash the reporter
 *   empty       → an action returning undefined (a plain sync handler) reports
 *                 nothing and does not throw on the absent `.catch`
 *   boundary    → success reports nothing at all; zero noise on the happy path
 *   race        → two invocations in flight together each report their own
 *                 failure, and one failing does not suppress the other
 *   authz       → a GUEST defers the action to sign-in replay; the rejection
 *                 that happens on replay is still reported
 *   UTF-8       → a Korean failure message survives intact
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { render, flush } from './harness/render';
import { useAuthGuardedAction } from '../auth/useAuthGuardedAction';

/**
 * The gate is the only thing this hook depends on. `require` either runs the
 * callback now (signed in) or parks it for replay (guest) — both paths matter,
 * so the double exposes the parked callback instead of hiding it.
 */
let parked: (() => void) | null = null;
let isGuest = false;

vi.mock('../components/SignInSheet', () => ({
  useSignInGate: () => ({
    require: (onSignedIn?: () => void) => {
      if (isGuest) {
        parked = onSignedIn ?? null;
        return false;
      }
      onSignedIn?.();
      return true;
    },
    open: () => {},
    close: () => {},
    isGuest,
  }),
}));

function Harness({ run }: { run: (...args: unknown[]) => void | Promise<void> }) {
  const guarded = useAuthGuardedAction(run);
  return (
    <TouchableOpacity onPress={() => guarded()}>
      <Text>trigger</Text>
    </TouchableOpacity>
  );
}

/** Press the button, then let the microtask queue drain so a rejection lands. */
async function fire(run: (...args: unknown[]) => void | Promise<void>) {
  const rendered = await render(<Harness run={run} />);
  await rendered.press(rendered.pressableWith('trigger')!);
  await flush();
}

let reported: unknown[][];

beforeEach(() => {
  parked = null;
  isGuest = false;
  reported = [];
  /*
   * Only OUR reports count. `react-test-renderer` writes its own deprecation
   * notice through `console.error`, and counting that would make every
   * "says nothing" assertion pass for the wrong reason.
   */
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[useAuthGuardedAction]')) {
      reported.push(args);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuthGuardedAction failure reporting', () => {
  it('reports a rejected async action instead of dropping it', async () => {
    const boom = new Error('upload refused');
    await fire(async () => {
      throw boom;
    });

    expect(reported).toHaveLength(1);
    // The error OBJECT, not a rendering of it — a stack is the whole point.
    expect(reported[0]).toContain(boom);
  });

  it('reports a synchronous throw, which never becomes a promise', async () => {
    const boom = new Error('threw before awaiting');
    await fire(() => {
      throw boom;
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(boom);
  });

  it('says nothing when the action succeeds', async () => {
    await fire(async () => {});
    expect(reported).toEqual([]);
  });

  it('says nothing, and does not throw, for a plain synchronous action', async () => {
    let ran = false;
    await fire(() => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(reported).toEqual([]);
  });

  it.each([
    ['a string', 'plain string rejection'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 0],
  ])('reports a non-Error rejection (%s) without crashing', async (_label, value) => {
    await fire(async () => {
      throw value;
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(value);
  });

  it('reports a rejection whose toString throws', async () => {
    /*
     * A throwing `toString` only — NOT a throwing `message` getter. Vitest
     * reads `.message` off a rejection while deciding how to report it, so a
     * throwing getter would fail inside the runner rather than inside the
     * code under test, and prove nothing about either.
     */
    const hostile = {
      toString() {
        throw new Error('nice try');
      },
    };
    await fire(async () => {
      throw hostile;
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(hostile);
  });

  it('keeps a Korean failure message intact', async () => {
    const boom = new Error('사진을 보낼 수 없습니다 — 업로드가 거부되었습니다');
    await fire(async () => {
      throw boom;
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(boom);
    expect((reported[0].find((a) => a === boom) as Error).message).toBe(
      '사진을 보낼 수 없습니다 — 업로드가 거부되었습니다',
    );
  });

  it('reports both failures when two are in flight together', async () => {
    const first = new Error('first');
    const second = new Error('second');
    let call = 0;
    const rendered = await render(
      <Harness
        run={async () => {
          throw call++ === 0 ? first : second;
        }}
      />,
    );
    // Same guarded callback, pressed twice — neither failure hides the other.
    await rendered.press(rendered.pressableWith('trigger')!);
    await rendered.press(rendered.pressableWith('trigger')!);
    await flush();

    expect(reported).toHaveLength(2);
    expect(reported.flat()).toContain(first);
    expect(reported.flat()).toContain(second);
  });

  it('reports a rejection that happens on the guest sign-in replay', async () => {
    isGuest = true;
    const boom = new Error('failed after signing in');
    const rendered = await render(
      <Harness
        run={async () => {
          throw boom;
        }}
      />,
    );
    await rendered.press(rendered.pressableWith('trigger')!);

    // Guest: the action is parked, not run — so nothing has failed yet.
    expect(reported).toEqual([]);
    expect(parked).toBeTypeOf('function');

    // Sign-in completes and the gate replays it. THAT failure still reports.
    parked?.();
    await flush();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(boom);
  });
});
