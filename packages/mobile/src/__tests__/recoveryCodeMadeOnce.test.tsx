/*
 * The recovery key is created ONCE per launch, and only when it is wanted.
 *
 * THE FAILURE THIS EXISTS FOR. `backupWithRecoveryCode` generates a code, wraps
 * `master_key` with it, and UPLOADS the wrap — replacing whatever was on file.
 * Two calls therefore leave the server holding the second wrap while the person
 * is looking at whichever code rendered. Written down, it opens nothing. That is
 * worse than showing no code at all, because it looks like it worked and the
 * discovery comes at the one moment it cannot be fixed: a new phone, no old
 * phone, and a key that does not fit.
 *
 * Two renders arriving together is not hypothetical — the sheet mounts while a
 * session query is settling, and effects re-run on every dependency change.
 *
 * THE AXIS IS REPETITION, again. A case that mounts once cannot see a second
 * call, and cannot see the twentieth launch still asking.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   race (THE guard) → concurrent renders create exactly one key
 *   repetition       → 20 launches with a key on file create none
 *   contract         → the sheet opens BEFORE the key exists, then fills in
 *   integrity        → nothing happens while the backup state is still loading
 *   authz            → a signed-out app is never asked
 *   external         → a creation failure surfaces instead of hanging on "…"
 *   integrity        → dismissing does not mark it stored
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, flush } from './harness/render';
import { useFirstRunRecovery, type FirstRunRecoveryDeps } from '../hooks/useFirstRunRecovery';
import { RECOVERY_SHOWN_KEY, type LocalFlagStore } from '../lib/firstRunRecovery';

function store(): LocalFlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

const NO_BACKUP = { hasRecoveryWrap: false, hasPasskey: false };
const HAS_CODE = { hasRecoveryWrap: true, hasPasskey: false };

/** Renders the hook and exposes what it returned. */
function Probe({ deps, sink }: { deps: FirstRunRecoveryDeps; sink: { current: unknown } }) {
  const state = useFirstRunRecovery(deps);
  sink.current = state;
  return null;
}

type State = ReturnType<typeof useFirstRunRecovery>;

async function mount(over: Partial<FirstRunRecoveryDeps> = {}) {
  const s = store();
  const created: string[] = [];
  const deps: FirstRunRecoveryDeps = {
    authenticated: true,
    store: s,
    backups: NO_BACKUP,
    isFirstRun: true,
    createCode: async () => {
      const c = `code-${created.length + 1}`;
      created.push(c);
      return c;
    },
    ...over,
  };
  const sink = { current: null as unknown };
  const r = await render(<Probe deps={deps} sink={sink} />);
  await flush();
  return { r, sink: sink as { current: State }, created, flagStore: s };
}

describe('the recovery key is created once', () => {
  it('RACE: re-rendering with the SAME deps creates exactly one key', async () => {
    /*
     * THE guard. The second upload replaces the first wrap, so the code on
     * screen may no longer be the one that opens anything.
     *
     * The first draft of this case re-rendered with a DIFFERENT deps object
     * whose store was null — so nothing could have been created either way, and
     * it passed for a reason that had nothing to do with the guard. Same shape
     * as the vacuous pass caught in `oneDeviceKeptByKey` an hour earlier. The
     * deps here are the identical object, so only `started` stops the second
     * call.
     */
    const s = store();
    const created: string[] = [];
    const deps: FirstRunRecoveryDeps = {
      authenticated: true,
      store: s,
      backups: NO_BACKUP,
      isFirstRun: true,
      createCode: async () => {
        const c = `code-${created.length + 1}`;
        created.push(c);
        return c;
      },
    };
    const sink = { current: null as unknown };

    const r = await render(<Probe deps={deps} sink={sink} />);
    await flush();
    await r.update(<Probe deps={deps} sink={sink} />);
    await flush();
    await r.update(<Probe deps={deps} sink={sink} />);
    await flush();

    expect(created).toEqual(['code-1']);
  });

  it('RACE: a NEW backups object re-runs the effect and must not create again', async () => {
    /*
     * THE guard, and the previous case was not it.
     *
     * Re-rendering with the identical deps cannot call twice — React skips the
     * effect when the dependency array is unchanged. Measured: removing
     * `started` entirely still gave exactly one call. So that case passes with
     * or without the thing it claims to protect.
     *
     * The real path is a dependency that CHANGES IDENTITY without changing
     * meaning, which is what a settling query does: `{ hasRecoveryWrap: false,
     * hasPasskey: false }` arrives again as a fresh object, the effect re-runs,
     * and without `started` the second run uploads a second wrap — replacing the
     * first. The person is then holding a code that opens nothing.
     */
    const s = store();
    const created: string[] = [];
    const createCode = async () => {
      const c = `code-${created.length + 1}`;
      created.push(c);
      return c;
    };
    const sink = { current: null as unknown };
    const mk = (backups: { hasRecoveryWrap: boolean; hasPasskey: boolean }) => (
      <Probe
        deps={{ authenticated: true, store: s, backups, isFirstRun: true, createCode }}
        sink={sink}
      />
    );

    const r = await render(mk({ hasRecoveryWrap: false, hasPasskey: false }));
    await flush();
    // Same VALUE, new object — exactly what a refetch produces.
    await r.update(mk({ hasRecoveryWrap: false, hasPasskey: false }));
    await flush();
    await r.update(mk({ hasRecoveryWrap: false, hasPasskey: false }));
    await flush();

    expect(created).toEqual(['code-1']);
  });

  it('REPETITION: 20 launches with a key on file create none', async () => {
    let calls = 0;
    for (let i = 0; i < 20; i++) {
      await mount({
        backups: HAS_CODE,
        isFirstRun: i === 0,
        createCode: async () => {
          calls += 1;
          return 'never';
        },
      });
    }
    expect(calls).toBe(0);
  });

  it('CONTRACT: the sheet opens before the key exists, then fills in', async () => {
    /*
     * Opening late means a blank screen for the length of a round trip, with no
     * way to report a failure. Opening early means the sheet can say "creating…"
     * and then say what went wrong.
     */
    let release!: (c: string) => void;
    const pending = new Promise<string>((res) => {
      release = res;
    });

    const { sink } = await mount({ createCode: () => pending });

    expect(sink.current.prompt?.kind).toBe('show');
    expect(sink.current.code).toBeNull();

    release('the-code');
    await flush();

    expect(sink.current.code).toBe('the-code');
  });

  it('INTEGRITY: nothing happens while the backup state is still loading', async () => {
    /*
     * Asking before the server answers would show the sheet to an account that
     * already has a key — and the first thing it would do is replace the wrap
     * the person may have written down months ago.
     */
    const { sink, created } = await mount({ backups: null });

    expect(sink.current.prompt).toBeNull();
    expect(created).toEqual([]);
  });

  it('AUTHZ: a signed-out app is never asked', async () => {
    const { sink, created } = await mount({ authenticated: false });

    expect(sink.current.prompt).toBeNull();
    expect(created).toEqual([]);
  });

  it('EXTERNAL: a creation failure surfaces instead of hanging', async () => {
    const { sink } = await mount({
      createCode: async () => {
        throw new Error('upload refused');
      },
    });

    expect(sink.current.prompt?.kind).toBe('show');
    expect(sink.current.error).toMatch(/upload refused/);
    expect(sink.current.code).toBeNull();
  });

  it('CONTRACT: storing marks it stored; dismissing does not', async () => {
    // A dismissed sheet must never look like a completed one, or the next
    // launch believes a key was written down that was only glanced at.
    const a = await mount();
    a.sink.current.onStored();
    await flush();
    expect(a.flagStore.data.get(RECOVERY_SHOWN_KEY)).toBe('stored');

    const b = await mount();
    b.sink.current.onDismiss();
    await flush();
    expect(b.flagStore.data.get(RECOVERY_SHOWN_KEY)).toBe('pending');
  });

  it('CONTRACT: both actions close the sheet', async () => {
    const { sink } = await mount();
    expect(sink.current.prompt?.kind).toBe('show');

    sink.current.onDismiss();
    await flush();

    expect(sink.current.prompt).toBeNull();
  });
});

/*
 * THE SHEET MUST NOT STRAND ON "Creating your recovery key…".
 *
 * SEEN ON A PHONE, 2026-08-27. Signing in sends the app to the proof screen, so
 * it spends ~84s in the background. On return `backups` is re-fetched and its
 * new object identity re-runs the effect. The old shape set `cancelled = true`
 * in the CLEANUP — which React calls on every dependency change, not only on
 * unmount — so the in-flight `createCode()` resolved into a discarded `setCode`,
 * and the re-run hit the `started` latch and returned. Server log:
 * `recovery-code master_key backup stored {"bytes":60}`. Screen: "Creating your
 * recovery key…", forever. No code meant no note was ever filed either.
 *
 * WHAT THE EXISTING NINE CASES MISSED. They re-render with the SAME deps, which
 * does not re-run the effect at all — so the cleanup never fired and the bug
 * could not appear. The axis that finds it is a re-render with a CHANGED
 * dependency while the creation is still in flight.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   race      → a dep changes mid-flight: the code still arrives
 *   race      → and exactly one key is created, not two
 *   integrity → an error mid-flight still surfaces after a dep change
 *   boundary  → N dep changes in a row, all before the promise settles
 */
describe('a dependency change mid-creation does not strand the sheet', () => {
  /** A `createCode` the test resolves by hand, so "in flight" is a real state. */
  function deferred() {
    let settle: (v: string) => void = () => {};
    let fail: (e: Error) => void = () => {};
    let calls = 0;
    const createCode = () => {
      calls += 1;
      return new Promise<string>((res, rej) => {
        settle = res;
        fail = rej;
      });
    };
    return {
      createCode,
      resolve: (v: string) => settle(v),
      reject: (e: Error) => fail(e),
      get calls() {
        return calls;
      },
    };
  }

  it('RACE: the code still arrives when `backups` changes mid-flight', async () => {
    const d = deferred();
    const s = store();
    const sink = { current: null as unknown };
    const base: FirstRunRecoveryDeps = {
      authenticated: true,
      store: s,
      backups: { hasRecoveryWrap: false, hasPasskey: false },
      isFirstRun: true,
      createCode: d.createCode,
    };

    const r = await render(<Probe deps={base} sink={sink} />);
    await flush();
    expect(d.calls).toBe(1);

    // The app came back from the proof screen and the query re-fetched: same
    // values, NEW object. This is what re-runs the effect.
    await r.update(
      <Probe deps={{ ...base, backups: { hasRecoveryWrap: false, hasPasskey: false } }} sink={sink} />,
    );
    await flush();

    d.resolve('THE-CODE');
    await flush();

    expect((sink.current as State).code).toBe('THE-CODE');
    // ...and the re-run must not have started a second creation, which would
    // replace the wrap the person is about to write down.
    expect(d.calls).toBe(1);
    r.unmount();
  });

  it('BOUNDARY: five dep changes before it settles still deliver one code', async () => {
    // One change could be a coincidence of ordering; five cannot.
    const d = deferred();
    const s = store();
    const sink = { current: null as unknown };
    const base: FirstRunRecoveryDeps = {
      authenticated: true,
      store: s,
      backups: { hasRecoveryWrap: false, hasPasskey: false },
      isFirstRun: true,
      createCode: d.createCode,
    };

    const r = await render(<Probe deps={base} sink={sink} />);
    await flush();
    for (let i = 0; i < 5; i++) {
      await r.update(
        <Probe deps={{ ...base, backups: { hasRecoveryWrap: false, hasPasskey: false } }} sink={sink} />,
      );
      await flush();
    }

    d.resolve('LATE-CODE');
    await flush();

    expect((sink.current as State).code).toBe('LATE-CODE');
    expect(d.calls).toBe(1);
    r.unmount();
  });

  it('INTEGRITY: a failure mid-flight still reaches the sheet after a dep change', async () => {
    /*
     * The other half. If a discarded rejection left `error` null the sheet would
     * sit on "Creating…" just as it did — a different road to the same stranded
     * screen.
     */
    const d = deferred();
    const s = store();
    const sink = { current: null as unknown };
    const base: FirstRunRecoveryDeps = {
      authenticated: true,
      store: s,
      backups: { hasRecoveryWrap: false, hasPasskey: false },
      isFirstRun: true,
      createCode: d.createCode,
    };

    const r = await render(<Probe deps={base} sink={sink} />);
    await flush();
    await r.update(
      <Probe deps={{ ...base, backups: { hasRecoveryWrap: false, hasPasskey: false } }} sink={sink} />,
    );
    await flush();

    d.reject(new Error('upload refused'));
    await flush();

    expect((sink.current as State).error).toContain('upload refused');
    r.unmount();
  });
});
