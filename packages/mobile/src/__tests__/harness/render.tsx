/**
 * Render a mini-app component and ask questions about what came out.
 *
 * `react-test-renderer` is resolved from the host app (see
 * `vitest.config.ts`) rather than installed here — this package deliberately
 * has no `node_modules`, and adding one for tests would be a heavier change
 * than the tests are worth.
 *
 * The helpers below are deliberately few: find text, find a pressable by the
 * text inside it, press it. Anything richer starts encoding assumptions about
 * how a screen is laid out, and a test that knows the layout fails when the
 * layout changes for a reason nobody cares about.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export interface Rendered {
  root: ReactTestInstance;
  /** Every string rendered anywhere in the tree, concatenated. */
  text(): string;
  /** The first pressable whose subtree contains `label`, or undefined. */
  pressableWith(label: string): ReactTestInstance | undefined;
  /** Every pressable whose subtree contains `label`. */
  pressablesWith(label: string): ReactTestInstance[];
  press(target: ReactTestInstance): Promise<void>;
  update(element: React.ReactElement): Promise<void>;
  unmount(): void;
}

/** Host names the stand-in uses for anything you can press. */
const PRESSABLE_TYPES = new Set(['TouchableOpacity', 'Pressable']);

function collectText(node: ReactTestInstance): string {
  let out = '';
  for (const child of node.children) {
    out += typeof child === 'string' ? child : collectText(child);
  }
  return out;
}

/**
 * A query client per render, so screens that read or invalidate a cache work
 * here without every test knowing they do.
 *
 * WITHOUT THIS, adding `useQueryClient` to a screen breaks every unrelated test
 * that renders it, with an error naming react-query rather than the screen —
 * which is what happened on 2026-08-27 when the recovery screen started telling
 * open rooms to re-decrypt. The tests were right and the harness was thin.
 *
 * Retries off and no logger noise: a test asserting on a failure should see it
 * on the first attempt, not three seconds later.
 */
function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

export async function render(element: React.ReactElement): Promise<Rendered> {
  let renderer!: TestRenderer.ReactTestRenderer;
  const queryClient = freshQueryClient();
  const wrap = (el: React.ReactElement) => (
    <QueryClientProvider client={queryClient}>{el}</QueryClientProvider>
  );
  await act(async () => {
    renderer = TestRenderer.create(wrap(element));
  });
  // Let effects that kicked off promises settle before anyone asserts.
  await flush();

  const root = renderer.root;
  /*
   * Host elements are compared BY NAME, and the names come from the stand-in
   * (`TouchableOpacity`, `Pressable`) rather than from React's DOM element
   * union — so the comparison is widened deliberately rather than the mock
   * being bent to satisfy a type that describes a different platform.
   */
  const isPressable = (type: unknown): boolean =>
    typeof type === 'string' && (type as string) !== '' && PRESSABLE_TYPES.has(type as string);
  /*
   * A control is found by what it SAYS — its visible text, or, when it shows a
   * glyph instead of words, its accessibility label.
   *
   * Text alone was enough until the failed-send controls became a refresh icon
   * and a cross (they were being pushed off the left edge of the screen as
   * words). Six tests went red at once, all of them still describing the right
   * contract — the harness had simply lost the only handle an icon has. A
   * screen reader finds these controls by exactly this label, so matching on it
   * is not a workaround for the icons; it is the same question a person asks.
   */
  const pressablesWith = (label: string): ReactTestInstance[] =>
    root
      .findAll((n) => isPressable(n.type))
      .filter(
        (n) =>
          collectText(n).includes(label) ||
          String(n.props.accessibilityLabel ?? '').includes(label),
      );

  return {
    root,
    text: () => collectText(root),
    pressableWith: (label) => pressablesWith(label)[0],
    pressablesWith,
    async press(target) {
      const onPress = target.props.onPress as (() => unknown) | undefined;
      if (!onPress) throw new Error('that element has no onPress');
      await act(async () => {
        await onPress();
      });
      await flush();
    },
    async update(next) {
      // Same provider, or an update drops the screen's query client mid-test.
      await act(async () => {
        renderer.update(wrap(next));
      });
      await flush();
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Drain the microtask queue a few times, inside `act`. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Drain until `done()` is true, rather than a fixed number of times.
 *
 * WHY THIS EXISTS. `flush()` runs six ticks, which is a guess about how long the
 * effect under test takes — and a guess that goes stale the moment somebody adds
 * an `await` to a module three levels down. That happened on 2026-08-26:
 * `crypto/deviceKey.ts` moved its native import from static to
 * `await import(...)`, which put the key generation one dynamic-import tick
 * further away, and `deviceProofLatchesPerAccount` failed FOUR cases in one full
 * run and passed on the next two. The assertions were right; the waiting was.
 *
 * Raising the count would only move the cliff. Waiting on the CONDITION removes
 * it: a chain that finishes in two ticks costs two, and one that grows next year
 * still passes.
 *
 * The cap is a real failure, not a longer wait — a predicate that never becomes
 * true means the effect did not run, and hanging the suite would hide that.
 */
export async function flushUntil(
  done: () => boolean,
  { max = 200, label = 'condition' }: { max?: number; label?: string } = {},
): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (done()) return;
    await act(async () => {
      await Promise.resolve();
      /*
       * AND a real timer, which is what buys the work under test actual TIME.
       *
       * THE FLAKE THIS FIXES, seen once in a full-suite run on 2026-08-27 and
       * not when the file ran alone. The chain under test reaches
       * `signChallenge` → `loadEd()`, a DYNAMIC `import()`. Draining microtasks
       * 200 times costs about ten milliseconds; a cold module load on a machine
       * running the whole suite in parallel takes far longer, so the budget ran
       * out and the helper reported "the effect did not complete" — which reads
       * as a defect in the code rather than as a stopwatch set too short. The
       * second run found the module cached and passed, which is the signature.
       *
       * NOT a starved queue: `act` already lets timers run, and removing this
       * line does not break a test written that way. The axis is elapsed time,
       * so a timer per tick is the fix — the same 200 ticks now span hundreds
       * of milliseconds instead of ten.
       *
       * No test that uses this helper runs fake timers, so a real timer is safe.
       */
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
  if (!done()) {
    throw new Error(
      `flushUntil: ${label} was still false after ${max} ticks — the effect under ` +
        'test did not complete. This is a real failure, not a slow one.',
    );
  }
}
