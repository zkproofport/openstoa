import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../theme/ThemeContext';
import { OpenStoaMarkIcon } from '../../components/icons';

export interface WelcomeScreenProps {
  onSignIn: () => void;
  onContinueAsGuest: () => void;
  /** Disables both buttons during inflight host work (e.g. login spawning). */
  busy?: boolean;
  /** Shown above the buttons when a previous login attempt failed. */
  errorMessage?: string | null;
}

/**
 * First-launch / signed-out OpenStoa entry. Lets the user pick between
 * Sign in (ZK proof flow on the host) and Browse as guest (read-only).
 */
export function WelcomeScreen({
  onSignIn,
  onContinueAsGuest,
  busy,
  errorMessage,
}: WelcomeScreenProps) {
  const { colors } = useThemeColors();
  const { t } = useTranslation();

  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 380,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, slide]);

  return (
    <View
      style={[styles.root, { backgroundColor: colors.background.primary }]}
    >
      <Animated.View
        style={[
          styles.body,
          {
            opacity: fade,
            transform: [{ translateY: slide }],
          },
        ]}
      >
        {/* Reuse the same icon the bottom tab bar uses — that one is known
            to render reliably (the previous standalone Image was getting
            cancelled by Metro's localhost connection before the bitmap
            arrived). */}
        <View style={styles.iconWrap}>
          <OpenStoaMarkIcon size={120} color={colors.brand.primary} />
        </View>

        <Text style={[styles.heading, { color: colors.text.primary }]}>
          {t('openstoa.welcome.heading')}
        </Text>
        <Text style={[styles.subtitle, { color: colors.text.secondary }]}>
          {t('openstoa.welcome.subtitle')}
        </Text>

        <View style={styles.bullets}>
          <BulletRow text={t('openstoa.welcome.bullet1')} colors={colors} />
          <BulletRow text={t('openstoa.welcome.bullet2')} colors={colors} />
          <BulletRow text={t('openstoa.welcome.bullet3')} colors={colors} />
        </View>
      </Animated.View>

      <View style={styles.footer}>
        {errorMessage ? (
          <Text style={[styles.error, { color: colors.status.danger }]}>
            {errorMessage}
          </Text>
        ) : null}

        <Pressable
          onPress={onSignIn}
          disabled={busy}
          style={({ pressed }) => [
            styles.primaryButton,
            {
              backgroundColor: colors.brand.primary,
              opacity: busy ? 0.6 : pressed ? 0.85 : 1,
            },
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {busy
              ? t('openstoa.welcome.signingIn')
              : t('openstoa.welcome.signIn')}
          </Text>
        </Pressable>

        <Pressable
          onPress={onContinueAsGuest}
          disabled={busy}
          style={({ pressed }) => [
            styles.secondaryButton,
            {
              opacity: busy ? 0.5 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Text
            style={[styles.secondaryButtonText, { color: colors.text.secondary }]}
          >
            {t('openstoa.welcome.continueAsGuest')}
          </Text>
        </Pressable>

        <Text style={[styles.legal, { color: colors.text.tertiary }]}>
          {t('openstoa.welcome.legal')}
        </Text>
      </View>
    </View>
  );
}

function BulletRow({
  text,
  colors,
}: {
  text: string;
  colors: ReturnType<typeof useThemeColors>['colors'];
}) {
  return (
    <View style={styles.bulletRow}>
      <View
        style={[
          styles.bulletDot,
          { backgroundColor: colors.brand.accent },
        ]}
      />
      <Text style={[styles.bulletText, { color: colors.text.secondary }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 64,
    paddingBottom: 32,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    // Vertically centered in the body's remaining space — the user
    // pointed out that flex-start left a huge dead gap between the
    // bullets and the CTA stack. Centering pulls everything closer to
    // a balanced layout.
    justifyContent: 'center',
  },
  iconWrap: {
    marginBottom: 28,
  },
  // Typography mirrors `LoadingScreen.appName` (32 / bold) and stays
  // unstyled below — no custom letterSpacing or extra weights — so the
  // mini-app reads as the same brand as the host boot.
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  bullets: {
    alignSelf: 'stretch',
    paddingHorizontal: 8,
    gap: 10,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    paddingHorizontal: 4,
    gap: 12,
  },
  error: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 4,
  },
  primaryButton: {
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  secondaryButton: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  legal: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
});
