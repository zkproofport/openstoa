/**
 * A thin React Native stand-in, so mini-app components can be RENDERED in a
 * test instead of only reasoned about.
 *
 * Why this exists: the failed-attachment row shipped with nine component tests
 * on the web and none here, because this package had no renderer — and mobile
 * is where the OS kills the app, which is the case that row exists for. Twice
 * in that work "a thing worked" and "a thing rendered" turned out to be
 * different questions (a restore that was correctly written, correctly parsed,
 * and wiped by the room-clear before paint). Only a renderer catches that.
 *
 * DELIBERATELY THIN. Each component here is a host element that keeps its
 * props — nothing simulates layout, styling, gestures or native behaviour. The
 * point is that a change in a native module SURFACES rather than being absorbed
 * by a mock that quietly does the same thing anyway: if a screen starts calling
 * something this file does not define, the test fails loudly at the import
 * instead of passing against a fiction.
 *
 * Not for one test file. `packages/mobile/vitest.config.ts` aliases
 * `react-native` here for every `.tsx` test, so the next screen inherits it.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

/** Style types are structural here — nothing in a test depends on their shape. */
export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type ImageStyle = Record<string, unknown>;
export type StyleProp<T> = T | T[] | null | undefined | false;

/** A host element named after the RN component, keeping every prop it was given. */
function host(name: string) {
  const Component = (props: AnyProps) => React.createElement(name, props, props.children);
  Component.displayName = name;
  return Component;
}

export const View = host('View');
export const Text = host('Text');
export const ScrollView = host('ScrollView');
export const TextInput = host('TextInput');
export const ActivityIndicator = host('ActivityIndicator');
export const Modal = host('Modal');
export const Image = host('Image');
export const KeyboardAvoidingView = host('KeyboardAvoidingView');
export const TouchableOpacity = host('TouchableOpacity');
export const Pressable = host('Pressable');

/**
 * `FlatList` renders its rows eagerly here.
 *
 * The real one virtualises, so on a device only some rows exist. A test that
 * asserts "the failed row is on screen" is asking about the DATA reaching the
 * list, not about windowing — and a mock that virtualised would make that
 * assertion depend on a scroll position no test has.
 */
export function FlatList<T>(props: {
  data?: readonly T[];
  renderItem?: (info: { item: T; index: number }) => React.ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  [k: string]: unknown;
}) {
  const rows = (props.data ?? []).map((item, index) =>
    React.createElement(
      React.Fragment,
      { key: props.keyExtractor?.(item, index) ?? String(index) },
      props.renderItem?.({ item, index }),
    ),
  );
  return React.createElement('FlatList', { ...props, data: undefined, renderItem: undefined }, rows);
}

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  absoluteFillObject: {},
  hairlineWidth: 1,
};

export const Platform = { OS: 'ios' as 'ios' | 'android', select: (o: Record<string, unknown>) => o.ios ?? o.default };

/** Calls are RECORDED, not swallowed — a test asserts what the user was told. */
export const Alert = {
  alerts: [] as Array<{ title?: string; message?: string }>,
  alert(title?: string, message?: string) {
    Alert.alerts.push({ title, message });
  },
  reset() {
    Alert.alerts = [];
  },
};

export const ActionSheetIOS = {
  calls: [] as unknown[],
  showActionSheetWithOptions(options: unknown, callback: (i: number) => void) {
    ActionSheetIOS.calls.push({ options, callback });
  },
  reset() {
    ActionSheetIOS.calls = [];
  },
};

export const Linking = { openURL: async () => {} };
export const Keyboard = { dismiss: () => {} };
export const Dimensions = { get: () => ({ width: 390, height: 844 }) };
export const Animated = { View, Text, timing: () => ({ start: () => {} }), Value: class {} };

/*
 * The members a FULL SCREEN reaches for, as opposed to a single component (T-1).
 *
 * Each one was added because mounting `ChatRoomScreen` failed at it — which is
 * this file working as designed rather than a gap in it: the screen asked for
 * something undefined and the test said so at the point of use instead of
 * absorbing it. They are kept as thin as everything above; the sizes match
 * `Dimensions.get` so a component cannot observe the two disagreeing.
 */
export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 2, fontScale: 1 });
export const useColorScheme = () => 'light' as const;
/** Always foreground. A test that needs a background transition drives it itself. */
export const AppState = {
  currentState: 'active' as const,
  addEventListener: () => ({ remove: () => {} }),
};
/**
 * Runs the callback SYNCHRONOUSLY.
 *
 * On a device this defers until animations finish; deferring here would mean a
 * screen's post-interaction work never ran inside `act`, and the test would
 * assert against a tree that had not finished settling — the exact "a thing
 * rendered vs a thing worked" gap this harness exists to close.
 */
export const InteractionManager = {
  runAfterInteractions: (cb: () => void) => {
    cb();
    return { cancel: () => {} };
  },
};
export const RefreshControl = host('RefreshControl');

export default {
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  Image,
  KeyboardAvoidingView,
  TouchableOpacity,
  Pressable,
  FlatList,
  StyleSheet,
  Platform,
  Alert,
  ActionSheetIOS,
  Linking,
  Keyboard,
  Dimensions,
  Animated,
  useWindowDimensions,
  useColorScheme,
  AppState,
  InteractionManager,
  RefreshControl,
};
