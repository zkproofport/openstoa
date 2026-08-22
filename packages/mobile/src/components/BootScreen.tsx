import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
// Reuse the same icon component the bottom tab bar uses — proves the asset
// path works (it renders correctly in the tab bar), so any rendering issue
// we still see is in the screen wrapping, not in the Image itself.
import { OpenStoaMarkIcon } from './icons';
import { TYPE_SCALE } from '../theme/tokens';

interface BootScreenProps {
  /** Optional one-line status under the tagline (e.g. "Preparing your anonymous identity…"). */
  status?: string | null;
  /**
   * What to do when the person gives up waiting. Omitted → no control at all,
   * which is right for the ordinary boot beat: it lasts three seconds and
   * cancelling it would mean nothing.
   *
   * Supplied for sign-in, where the wait can be minutes of real proof work —
   * and where, before this existed, a login that never came back could only be
   * escaped by force-quitting the app.
   */
  onCancel?: () => void;
  /** Label for the cancel control. Required in practice whenever `onCancel` is. */
  cancelLabel?: string;
  /** One line above the control, explaining why it has appeared. */
  cancelHint?: string | null;
  /**
   * How long to wait before showing the control, in ms.
   *
   * Not zero by default: a control that appears instantly and vanishes half a
   * second later reads as a glitch, and invites a tap that aborts something
   * which was about to succeed. `0` shows it immediately — used by tests.
   */
  cancelAfterMs?: number;
}

/**
 * OpenStoa mini-app boot screen — shown briefly while the app resolves
 * its host session state. Distinct from the host's native splash so the
 * tab-switch into OpenStoa still has a branded entry beat.
 *
 * The icon is rendered as a layered stack so SOMETHING is always visible:
 *   1. A brand-coloured rounded square fallback (always visible)
 *   2. The OpenStoa OS-mark PNG on top (visible unless asset bundling
 *      fails — in which case the fallback alone still reads as the brand)
 * No `Animated.Image` + `tintColor` chicanery any more — that combo was
 * unreliable on RN 0.81 and the user kept getting blank space.
 */
export function BootScreen({
  status,
  onCancel,
  cancelLabel,
  cancelHint,
  cancelAfterMs = 8_000,
}: BootScreenProps) {
  const { colors } = useThemeColors();
  const { t } = useTranslation();

  // The control appears on a timer rather than with the screen — see
  // `cancelAfterMs`. State, not an animation, so a test can observe it.
  const [cancelVisible, setCancelVisible] = useState(false);
  useEffect(() => {
    if (!onCancel) {
      setCancelVisible(false);
      return;
    }
    if (cancelAfterMs <= 0) {
      setCancelVisible(true);
      return;
    }
    const timer = setTimeout(() => setCancelVisible(true), cancelAfterMs);
    return () => clearTimeout(timer);
  }, [onCancel, cancelAfterMs]);

  // Mirror the host's `LoadingScreen.tsx` splash pulse — scale 1 ↔ 1.05
  // over 2 s, looping. Safe to apply now that the icon is an inline SVG
  // (Path) rather than a Metro-served Image: there's no asset fetch to
  // cancel when the wrapping Animated.View re-renders.
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    ).start();
    Animated.timing(taglineOpacity, {
      toValue: 1,
      duration: 320,
      delay: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [pulseAnim, taglineOpacity]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background.primary }]}>
      <View style={styles.center}>
        <Animated.View
          style={[styles.iconWrap, { transform: [{ scale: pulseAnim }] }]}
        >
          <OpenStoaMarkIcon size={ICON_SIZE} color={colors.brand.primary} />
        </Animated.View>

        <Text style={[styles.brand, { color: colors.text.primary }]}>
          OpenStoa
        </Text>
        <Animated.Text
          style={[
            styles.tagline,
            { color: colors.text.secondary, opacity: taglineOpacity },
          ]}
        >
          {t('openstoa.boot.tagline')}
        </Animated.Text>

        {status ? (
          <Text style={[styles.status, { color: colors.text.tertiary }]}>
            {status}
          </Text>
        ) : null}

        {onCancel && cancelVisible ? (
          <View style={styles.cancelWrap}>
            {cancelHint ? (
              <Text style={[styles.cancelHint, { color: colors.text.tertiary }]}>
                {cancelHint}
              </Text>
            ) : null}
            <TouchableOpacity
              onPress={onCancel}
              accessibilityRole="button"
              hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
            >
              <Text style={[styles.cancelLabel, { color: colors.brand.primary }]}>
                {cancelLabel ?? t('openstoa.boot.cancelSignIn')}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const ICON_SIZE = 120;

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    // Vertically centered — that's how a launch/boot beat should sit on
    // screen (host LoadingScreen does the same).
    justifyContent: 'center',
    padding: 32,
  },
  iconWrap: {
    marginBottom: 28,
  },
  // Match the host's `LoadingScreen.appName` / `tagline` typography
  // (32 / bold + 14 plain) so the boot beat feels like one continuous
  // brand surface across host → mini-app.
  brand: {
    fontSize: TYPE_SCALE.headingLarge,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  tagline: {
    fontSize: TYPE_SCALE.bodySmall,
  },
  status: {
    marginTop: 28,
    fontSize: TYPE_SCALE.label,
  },
  cancelWrap: {
    marginTop: 24,
    alignItems: 'center',
  },
  cancelHint: {
    fontSize: TYPE_SCALE.label,
    marginBottom: 10,
    textAlign: 'center',
  },
  cancelLabel: {
    fontSize: TYPE_SCALE.bodySmall,
    fontWeight: '600',
  },
});
