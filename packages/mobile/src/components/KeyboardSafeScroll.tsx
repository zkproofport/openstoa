import React from 'react';
import { Platform, ScrollView } from 'react-native';
import type { ScrollViewProps } from 'react-native';

/**
 * Mini-app mirror of the host's KeyboardSafeScroll. Every TextInput screen in
 * openstoa-mobile uses this so the focused input always rolls above the
 * keyboard instead of being covered by it.
 *
 *   iOS:     automaticallyAdjustKeyboardInsets auto-adjusts the scroll content
 *            inset by the keyboard height (RN 0.81+).
 *   Android: windowSoftInputMode="adjustResize" handles it natively.
 *
 * Defaults can be overridden by passing the prop explicitly.
 */
export const KeyboardSafeScroll = React.forwardRef<ScrollView, ScrollViewProps>(
  (props, ref) => (
    <ScrollView
      ref={ref}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      {...props}
    />
  ),
);
KeyboardSafeScroll.displayName = 'KeyboardSafeScroll';
