/**
 * Stand-in for `react-native-safe-area-context` (T-1's "native surface" rule).
 *
 * The real package measures the device's notch/home-indicator through a
 * native module — nothing to run off a device, same category as
 * `react-native-svg` in `nativeStubs.tsx`. It is also not an installed
 * dependency of this workspace at all (only the HOST app has it), so unlike
 * the peer-dependency aliases in `vitest.config.ts` there is no real copy to
 * borrow — see the probe in `safeAreaInsets.test.tsx` for the bare resolution
 * failure this replaces.
 *
 * `setSafeAreaInsets` / `resetSafeAreaInsets` give a test control over what
 * `useSafeAreaInsets()` returns, the same shape as `Alert.reset()` next door:
 * a component that reads insets should be exercised against a NON-ZERO top
 * inset at least once, because zero-on-every-side is indistinguishable from
 * "insets are wired but happen to be zero" and "insets are not wired at all".
 */
import React from 'react';

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

let current: EdgeInsets = { ...ZERO };

export function setSafeAreaInsets(next: Partial<EdgeInsets>): void {
  current = { ...current, ...next };
}

export function resetSafeAreaInsets(): void {
  current = { ...ZERO };
}

export function useSafeAreaInsets(): EdgeInsets {
  return current;
}

function host(name: string) {
  const Component = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement(name, props, props.children);
  Component.displayName = name;
  return Component;
}

export const SafeAreaProvider = host('SafeAreaProvider');
export const SafeAreaView = host('SafeAreaView');

export const initialWindowMetrics = {
  insets: ZERO,
  frame: { x: 0, y: 0, width: 390, height: 844 },
};
