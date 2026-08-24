/**
 * Stand-in for `react-native-keyboard-controller` (T-1's "native surface" rule).
 *
 * The real package reads the keyboard's frame from a native observer and moves
 * the view from a Reanimated worklet. Neither exists off a device, and the
 * package is installed in the HOST app only — the same category as
 * `safeAreaStub.tsx`, which is why this is a stub rather than a borrowed copy.
 *
 * WHAT THIS STUB CANNOT TELL YOU: whether the composer actually clears the
 * keyboard. Nothing here has a layout, a window, or a keyboard, so a test that
 * mounted this and asserted "the composer is above the keyboard" would pass
 * with the props set to any value at all — including the ones that shipped the
 * bug. Keyboard geometry is device-verified, full stop.
 *
 * WHAT IT CAN: keep the props, so a test can pin the CONTRACT — that the chat
 * composer asks for `automaticOffset` (the view's true window position) instead
 * of a hand-tuned `keyboardVerticalOffset`, which is the thing that was wrong
 * in both directions before. That guard goes red if someone puts a magic number
 * back, which is the regression worth catching from here.
 *
 * It refuses what the real component refuses: an unknown `behavior` throws
 * rather than rendering a view that quietly does nothing.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

/** The full set the real component accepts; anything else is a typo. */
const BEHAVIORS = new Set(['height', 'padding', 'position', 'translate-with-padding']);

function host(name: string) {
  const Component = (props: AnyProps) => React.createElement(name, props, props.children);
  Component.displayName = name;
  return Component;
}

export const KeyboardAvoidingView = (props: AnyProps) => {
  const { behavior } = props;
  if (behavior !== undefined && !BEHAVIORS.has(String(behavior))) {
    throw new Error(
      `KeyboardAvoidingView: unsupported behavior ${JSON.stringify(behavior)} — ` +
        `expected one of ${[...BEHAVIORS].join(', ')}`,
    );
  }
  return React.createElement('KeyboardAvoidingView', props, props.children);
};
KeyboardAvoidingView.displayName = 'KeyboardAvoidingView';

export const KeyboardStickyView = host('KeyboardStickyView');
export const KeyboardProvider = host('KeyboardProvider');
export const KeyboardAwareScrollView = host('KeyboardAwareScrollView');

/**
 * Always "closed". A test that needs the open state should say so explicitly
 * rather than inheriting a default that happens to suit it — and no test in
 * this package can currently prove anything about the open state anyway.
 */
export function useKeyboardState<T>(selector?: (state: { isVisible: boolean; height: number }) => T): T | { isVisible: boolean; height: number } {
  const state = { isVisible: false, height: 0 };
  return selector ? selector(state) : state;
}
