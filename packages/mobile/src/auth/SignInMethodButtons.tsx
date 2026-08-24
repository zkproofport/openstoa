import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import type { SignInMethod, SignInMethodId } from './signInMethods';

/**
 * The sign-in button stack, rendered the same way wherever sign-in is offered.
 *
 * It renders the list it is given and asks no questions about it — the list
 * comes from `signInMethods.ts`, which is the single place that decides what is
 * on offer (see that file's header for why). What stays with each SURFACE is
 * its chrome: the Welcome screen's heading, bullets and "continue as guest";
 * the sheet's title, expired copy and "Not now". Only the method buttons are
 * shared, because only the method LIST was ever duplicated.
 *
 * `size` is the one concession to the two surfaces looking different: a
 * full-screen entry wants taller buttons than a bottom sheet. It changes
 * metrics only — never which buttons exist, never their labels.
 */
export interface SignInMethodButtonsProps {
  /** What to offer, in display order. Usually `useOfferedSignInMethods()`. */
  methods: readonly SignInMethod[];
  /** Invoked with the method's id — hand it straight to the launcher. */
  onSelect: (id: SignInMethodId) => void;
  /** Disables every button (e.g. a host login already inflight). */
  busy?: boolean;
  /**
   * Replaces the PRIMARY method's label while `busy` — surface-specific copy
   * ("Opening secure sign-in…"), so it stays a prop rather than method data.
   */
  busyLabelKey?: string;
  /** `'lg'` = full-screen entry, `'md'` = bottom sheet. Metrics only. */
  size?: 'lg' | 'md';
}

export function SignInMethodButtons({
  methods,
  onSelect,
  busy,
  busyLabelKey,
  size = 'lg',
}: SignInMethodButtonsProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const metrics = size === 'lg' ? LARGE : MEDIUM;

  // An empty list renders nothing at all — no wrapper, no spacing artefact in
  // the surrounding stack. Reachable in principle (every method disabled), so
  // it renders the honest thing rather than an empty box.
  if (methods.length === 0) return null;

  return (
    <View style={[styles.stack, { gap: metrics.gap }]}>
      {methods.map((method) => {
        const primary = method.emphasis === 'primary';
        const label =
          primary && busy && busyLabelKey ? busyLabelKey : method.labelKey;

        return (
          <Pressable
            key={method.id}
            onPress={() => onSelect(method.id)}
            disabled={Boolean(busy)}
            style={({ pressed }) => [
              styles.button,
              { height: metrics.height },
              primary
                ? { backgroundColor: colors.brand.primary }
                : {
                    borderWidth: 1.5,
                    borderColor: colors.brand.primary,
                    backgroundColor: 'transparent',
                  },
              { opacity: busy ? (primary ? 0.6 : 0.5) : pressed ? 0.85 : 1 },
            ]}
          >
            <Text
              style={[
                styles.label,
                {
                  fontSize: primary
                    ? metrics.primaryFontSize
                    : TYPE_SCALE.bodySmall,
                  color: primary ? '#FFFFFF' : colors.brand.primary,
                },
              ]}
            >
              {t(label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Full-screen entry (WelcomeScreen). */
const LARGE = {
  height: 52,
  gap: 12,
  primaryFontSize: TYPE_SCALE.body,
} as const;

/** Bottom sheet (SignInSheet). */
const MEDIUM = {
  height: 48,
  gap: 8,
  primaryFontSize: TYPE_SCALE.body,
} as const;

const styles = StyleSheet.create({
  stack: {
    alignSelf: 'stretch',
  },
  button: {
    borderRadius: RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '700',
    letterSpacing: 0.1,
  },
});
