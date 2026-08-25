/**
 * The question asked before a second phone takes over an account.
 *
 * WHY THIS IS A SCREEN AND NOT AN ERROR STRING. The server refuses the sign-in
 * with a 409 because another phone holds this account. That refusal is not a
 * failure — it is the last moment anything can be done. The chat keys live on
 * that other phone and do not travel with the account, so signing in here
 * without a backup makes its private rooms unreadable on both devices,
 * permanently; and the only machine that can still make the backup is the one
 * that is signed in RIGHT NOW. Show "something went wrong" and the person taps
 * retry instead of going to make one.
 *
 * WHAT DECIDES THE WORDING is `takeoverNotice`, which reads the server's real
 * answer about whether a backup exists and how old it is. This file only draws
 * it. The split matters: the decision is testable without a renderer, and the
 * renderer cannot quietly disagree with it.
 *
 * THE ACTION ORDER IS THE MESSAGE. When there is no backup, "I'll back up
 * first" is the emphasised button and continuing is the plain one. It is never
 * a hard block — someone may have already wiped the old phone, or may not care
 * about the rooms, and refusing outright would strand them out of their own
 * account to protect data they have decided to lose.
 */

import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { TYPE_SCALE, RADIUS, TOUCH_TARGET_MIN } from '../theme';
import type { TakeoverNotice } from '../lib/deviceTakeover';

export interface DeviceTakeoverSheetProps {
  /** Null when there is nothing to ask. */
  notice: TakeoverNotice | null;
  /** They chose to continue: sign in here and end the other session. */
  onContinue: () => void;
  /** They chose to go and back up first, or simply backed out. */
  onCancel: () => void;
}

export default function DeviceTakeoverSheet({
  notice,
  onContinue,
  onCancel,
}: DeviceTakeoverSheetProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();

  if (!notice) return null;

  /*
   * With no backup, continuing is the destructive choice, so it must not be the
   * one a thumb lands on. Everywhere else continuing is ordinary and gets the
   * emphasis back.
   */
  const continueIsPrimary = notice.severity !== 'blocked';

  const styles = StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: colors.background.primary,
      borderTopLeftRadius: RADIUS.modal,
      borderTopRightRadius: RADIUS.modal,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 32,
      maxHeight: '85%',
    },
    title: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
      marginBottom: 12,
    },
    body: {
      fontSize: TYPE_SCALE.body,
      lineHeight: TYPE_SCALE.body * 1.5,
      color: colors.text.secondary,
    },
    restore: {
      fontSize: TYPE_SCALE.bodySmall,
      lineHeight: TYPE_SCALE.bodySmall * 1.45,
      color: colors.text.secondary,
      marginTop: 14,
      fontWeight: '600',
    },
    actions: { marginTop: 24, gap: 10 },
    button: {
      minHeight: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    primary: { backgroundColor: colors.brand.primary },
    primaryText: { color: colors.text.inverted, fontSize: TYPE_SCALE.body, fontWeight: '700' },
    secondary: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    secondaryText: { color: colors.text.primary, fontSize: TYPE_SCALE.body, fontWeight: '600' },
  });

  const continueButton = (
    <TouchableOpacity
      testID="takeover-continue"
      accessibilityRole="button"
      style={[styles.button, continueIsPrimary ? styles.primary : styles.secondary]}
      onPress={onContinue}
    >
      <Text style={continueIsPrimary ? styles.primaryText : styles.secondaryText}>
        {t('openstoa.takeover.continue')}
      </Text>
    </TouchableOpacity>
  );

  const backUpButton = (
    <TouchableOpacity
      testID="takeover-back-up-first"
      accessibilityRole="button"
      style={[styles.button, continueIsPrimary ? styles.secondary : styles.primary]}
      onPress={onCancel}
    >
      <Text style={continueIsPrimary ? styles.secondaryText : styles.primaryText}>
        {t(
          notice.severity === 'ready'
            ? 'openstoa.takeover.cancel'
            : 'openstoa.takeover.backUpFirst',
        )}
      </Text>
    </TouchableOpacity>
  );

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      /* Hardware back = the cautious answer, same as tapping outside. */
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="takeover-sheet">
          <ScrollView>
            <Text style={styles.title}>{t(notice.titleKey, notice.bodyValues)}</Text>
            <Text style={styles.body}>{t(notice.bodyKey, notice.bodyValues)}</Text>
            {notice.needsRestoreHere ? (
              <Text style={styles.restore}>{t('openstoa.takeover.restoreNote')}</Text>
            ) : null}
          </ScrollView>
          <View style={styles.actions}>
            {/* Primary first in the reading order, whichever one that is. */}
            {continueIsPrimary ? continueButton : backUpButton}
            {continueIsPrimary ? backUpButton : continueButton}
          </View>
        </View>
      </View>
    </Modal>
  );
}
