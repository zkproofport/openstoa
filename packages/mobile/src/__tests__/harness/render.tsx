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

export async function render(element: React.ReactElement): Promise<Rendered> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
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
  const pressablesWith = (label: string): ReactTestInstance[] =>
    root.findAll((n) => isPressable(n.type)).filter((n) => collectText(n).includes(label));

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
      await act(async () => {
        renderer.update(next);
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
