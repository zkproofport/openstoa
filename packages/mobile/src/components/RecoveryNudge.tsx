/**
 * The visible half of recovery: a dismissible banner prompting a user who has
 * chat history but no recovery at all.
 *
 * PROFILE ONLY. This used to be mounted at the app ROOT, above the tab
 * navigator, so it nagged from first launch on every tab — before the account
 * had any history worth protecting, with copy that reads as a warning. Someone
 * reading the feed does not need to be told about chat keys. It is now rendered
 * from exactly one place, `screens/profile/ProfileHomeScreen.tsx`, which makes
 * "Profile only" a property of where the element is rather than of a runtime
 * check a future screen could get wrong.
 *
 * IT NO LONGER RUNS THE REPAIR. The silent, account-level TAK-keychain repair
 * that used to share this component's effect now lives in `RecoveryRepair.tsx`,
 * mounted at the root wrapping the navigator — see that file for why binding it
 * to one screen would recreate the bug it exists to fix. What arrives here is
 * only the decision (`useRecoveryNudge()`), already made.
 *
 * NO SAFE-AREA INSET, DELIBERATELY. The root mount had nothing between it and
 * the window, so it had to add `insets.top` itself or render under the status
 * bar. Its only mount point now sits inside `ProfileStack`, below
 * `MiniAppHeader` (`navigation/shared.tsx`), which already applies
 * `paddingTop: insets.top` — adding it again would double-count and push the
 * banner ~50px down the screen on a notched device. Every other surface inside
 * that stack, `ProfileHomeScreen` included, reads no inset for the same reason.
 *
 * The CTA opens `AccountRecoveryScreen` in a modal rather than duplicating the
 * backup flow. That screen takes no navigation props, so it drops straight in.
 */
import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import { useRecoveryNudge } from './RecoveryRepair';
import { AccountRecoveryScreen } from '../screens/profile/AccountRecoveryScreen';

export function RecoveryNudge() {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();
  const { show, dismiss } = useRecoveryNudge();

  const [open, setOpen] = useState(false);

  if (!show) return null;

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.title}>{t('openstoa.recoveryNudge.title')}</Text>
      {/* States the loss plainly. A prompt that says "set up recovery" without
          saying what disappears without it is a prompt people rationally skip. */}
      <Text style={styles.body}>{t('openstoa.recoveryNudge.body')}</Text>
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={() => setOpen(true)}>
          <Text style={styles.btnText}>{t('openstoa.recoveryNudge.cta')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={dismiss}
          accessibilityLabel={t('openstoa.recoveryNudge.dismissAria')}
        >
          <Text style={styles.btnTextMuted}>{t('openstoa.recoveryNudge.dismiss')}</Text>
        </TouchableOpacity>
      </View>

      {/* Reuses the real recovery surface — no second copy of the flow. */}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalBar}>
            <TouchableOpacity onPress={() => setOpen(false)}>
              <Text style={styles.btnText}>{t('openstoa.recoveryNudge.close')}</Text>
            </TouchableOpacity>
          </View>
          <AccountRecoveryScreen />
        </View>
      </Modal>
    </View>
  );
}

/** Gap between whatever sits above the banner and its top edge. */
const BANNER_TOP_GAP = 12;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    banner: {
      marginHorizontal: 16,
      marginTop: BANNER_TOP_GAP,
      padding: 14,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.status.warning,
    },
    title: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '700', color: colors.text.primary },
    body: { fontSize: TYPE_SCALE.caption, color: colors.text.secondary, marginTop: 4, lineHeight: 18 },
    row: { flexDirection: 'row', gap: 8, marginTop: 10 },
    btn: {
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    btnText: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.primary, fontWeight: '600' },
    btnTextMuted: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.tertiary, fontWeight: '600' },
    modalRoot: { flex: 1, backgroundColor: colors.background.primary },
    modalBar: {
      paddingHorizontal: 16,
      paddingTop: 52,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.default,
    },
  });
}
