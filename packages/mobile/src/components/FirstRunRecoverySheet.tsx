/**
 * The recovery key, shown at the one moment somebody is certain to still have
 * the device that holds their keys.
 *
 * WHY IT IS A SHEET AND NOT A LINE IN SETTINGS. `master_key` is generated on
 * this phone and never leaves it. Everything sealed under it — group state,
 * archive keys, cached plaintexts — is unreadable to anyone without that key,
 * its owner included, on their next phone. The recovery key is the only copy
 * that exists off the device. A setting nobody opens is the same as no setting.
 *
 * WHAT DECIDES WHETHER IT APPEARS is `recoveryPrompt` in
 * `lib/firstRunRecovery.ts`, which reads the account's backup state and this
 * install's mark. This file only draws. Same split as `DeviceTakeoverSheet`:
 * the decision is testable without a renderer, and the renderer cannot quietly
 * disagree with it.
 *
 * NOT A HARD BLOCK. "Not now" is a real button. Someone signing in to read one
 * thing should not be trapped behind a key ceremony, and a modal that cannot be
 * dismissed is one people learn to fear rather than read. The cost of dismissing
 * is that `recoveryPrompt` asks again next launch — which is the correct
 * pressure, applied repeatedly rather than once and absolutely.
 *
 * "I HAVE SAVED IT" IS DISTINCT FROM CLOSING. The two write different marks, so
 * a dismissed sheet never looks like a completed one. Without that, the next
 * launch believes somebody wrote down a key they never even looked at.
 */
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { TYPE_SCALE, RADIUS, TOUCH_TARGET_MIN } from '../theme';
import type { RecoveryPrompt } from '../lib/firstRunRecovery';

export interface FirstRunRecoverySheetProps {
  /** Null when there is nothing to ask. */
  prompt: RecoveryPrompt | null;
  /**
   * The code, once it exists.
   *
   * Null while it is being created — the sheet opens BEFORE the key is ready so
   * the person is not looking at a blank screen during the round trip, and so a
   * failure has somewhere to be reported.
   */
  code: string | null;
  /** Set when creating the key failed, so the sheet can say so rather than hang. */
  error?: string | null;
  /** Copy to clipboard. */
  onCopy: (code: string) => void;
  /** They said they stored it. */
  onStored: () => void;
  /** They closed it without storing. */
  onDismiss: () => void;
}

export default function FirstRunRecoverySheet({
  prompt,
  code,
  error,
  onCopy,
  onStored,
  onDismiss,
}: FirstRunRecoverySheetProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const [copied, setCopied] = useState(false);

  if (!prompt || prompt.kind !== 'show') return null;

  const styles = makeStyles(colors);

  /*
   * The body differs by reason, and the difference is not cosmetic. A first run
   * is being told how the product works; an account that has been around
   * without a backup is being told about a risk it is already carrying.
   */
  const body =
    prompt.reason === 'first-run'
      ? t('openstoa.firstRunRecovery.bodyFirstRun')
      : t('openstoa.firstRunRecovery.bodyNoBackup');

  const copy = () => {
    if (!code) return;
    onCopy(code);
    setCopied(true);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>{t('openstoa.firstRunRecovery.title')}</Text>
            <Text style={styles.body}>{body}</Text>

            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {t('openstoa.firstRunRecovery.failed')}
              </Text>
            ) : code ? (
              <>
                <View style={styles.codeBox}>
                  <Text style={styles.code} selectable accessibilityLabel={code}>
                    {code}
                  </Text>
                </View>
                <Text style={styles.warning}>{t('openstoa.firstRunRecovery.warning')}</Text>
                <TouchableOpacity style={styles.secondary} onPress={copy} accessibilityRole="button">
                  <Text style={styles.secondaryText}>
                    {copied
                      ? t('openstoa.firstRunRecovery.copied')
                      : t('openstoa.firstRunRecovery.copy')}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.body}>{t('openstoa.firstRunRecovery.generating')}</Text>
            )}

            {/*
              * "I have saved it" is only offered once there IS something to have
              * saved. Offering it while the key is still being made invites the
              * one tap that makes the sheet never come back.
              */}
            {code && !error ? (
              <TouchableOpacity style={styles.primary} onPress={onStored} accessibilityRole="button">
                <Text style={styles.primaryText}>{t('openstoa.firstRunRecovery.stored')}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity style={styles.plain} onPress={onDismiss} accessibilityRole="button">
              <Text style={styles.plainText}>{t('openstoa.firstRunRecovery.later')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useThemeColors>['colors']) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
    sheet: {
      backgroundColor: colors.background.primary,
      borderTopLeftRadius: RADIUS.modal,
      borderTopRightRadius: RADIUS.modal,
      maxHeight: '85%',
    },
    content: { padding: 20, gap: 14 },
    title: { fontSize: TYPE_SCALE.headingSmall, fontWeight: '700', color: colors.text.primary },
    body: { fontSize: TYPE_SCALE.body, color: colors.text.secondary, lineHeight: 22 },
    warning: { fontSize: TYPE_SCALE.body, color: colors.status.warning, lineHeight: 22 },
    error: { fontSize: TYPE_SCALE.body, color: colors.status.danger, lineHeight: 22 },
    codeBox: {
      backgroundColor: colors.background.primary,
      borderRadius: RADIUS.card,
      padding: 16,
    },
    /*
     * Monospace and generously spaced: this is read off a screen and copied by
     * hand often enough that `l`/`1` and `O`/`0` have to be distinguishable.
     */
    code: {
      fontSize: TYPE_SCALE.body,
      fontFamily: 'Courier',
      letterSpacing: 1.5,
      color: colors.text.primary,
      textAlign: 'center',
    },
    primary: {
      minHeight: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.card,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: { fontSize: TYPE_SCALE.body, fontWeight: '700', color: colors.text.inverted },
    secondary: {
      minHeight: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.card,
      borderWidth: 1,
      borderColor: colors.border.default,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { fontSize: TYPE_SCALE.body, color: colors.text.primary },
    plain: { minHeight: TOUCH_TARGET_MIN, alignItems: 'center', justifyContent: 'center' },
    plainText: { fontSize: TYPE_SCALE.body, color: colors.text.secondary },
  });
}
