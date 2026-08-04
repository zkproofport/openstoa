/**
 * Mini-app twin of the web `RecoveryNudge` (design §10-1, Phase 4). Two jobs,
 * one pass over the same server state:
 *
 * 1. REPAIR (silent). Make sure the account has a TAK-keychain backup at all.
 *    `tak_key_backups` used to be written ONLY by the TAK key-change hook, which
 *    fires when a key is newly WRITTEN — so a user who already held their keys
 *    and then registered a passkey got a wrapped master_key and an EMPTY
 *    keychain row. Recovering returned the key and unlocked nothing, and simply
 *    opening a chat wrote no new key, so the hook never fired again. This runs
 *    at SESSION START, not on chat-room entry: the backup is account-level (one
 *    row per user, every topic), so binding its repair to one room is what let
 *    the gap persist.
 *
 * 2. NUDGE (visible, dismissible). Prompt a user who has chat history but no
 *    recovery at all. `shouldNudgeRecovery` owns that decision — including why
 *    the prompt waits until there is something to lose rather than firing at
 *    signup.
 *
 * The CTA opens `AccountRecoveryScreen` in a modal rather than duplicating the
 * backup flow. That screen takes no navigation props, so it drops straight in —
 * which is also why this component can live above the tab navigator, where a
 * `navigation.navigate` would not be available.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import { ensureTakKeychainBackup, keyBackupHttp } from '../crypto/mobileTransport';
import { recoveryNudgeDismissKey, shouldNudgeRecovery } from '../lib/recoveryNudge';
import { AccountRecoveryScreen } from '../screens/profile/AccountRecoveryScreen';

export function RecoveryNudge() {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();
  const host = useHost();
  const client = useOpenStoaClient();
  const session = useOpenStoaSession();

  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  // The repair is account-level and idempotent; running it once per signed-in
  // session is the point. Without this latch every re-render that flips a
  // dependency would re-run it (and re-decide a banner the user just dismissed).
  const ran = useRef(false);

  const secureStore = host.secureStore;
  const localStore = host.localStore;
  const userId = session.userId;
  const authenticated = session.mode === 'authenticated';

  useEffect(() => {
    // No secure store means no master_key on this device at all — backup and
    // recovery are both unavailable here, so there is nothing to repair and
    // nothing worth prompting for.
    if (ran.current || !authenticated || !userId || !secureStore) return;
    ran.current = true;

    void (async () => {
      // Runs even when the banner will be suppressed: the repair is the fix for
      // every account already in the broken state, and it is silent by design.
      const backup = await ensureTakKeychainBackup(client, secureStore, localStore);

      let dismissed = false;
      try {
        dismissed = (await localStore?.getItem(recoveryNudgeDismissKey(userId))) === '1';
      } catch {
        // Storage unavailable: treat as not dismissed. Erring towards showing a
        // dismissible banner beats hiding the only prompt a user gets about
        // history nobody can recover.
      }
      if (dismissed) return;

      let hasRecovery = false;
      try {
        const wraps = await keyBackupHttp(client).getBackup();
        hasRecovery = !!wraps.wrappedMaster || wraps.passkeys.length > 0;
      } catch {
        return; // offline: never nag on a guess
      }

      setShow(shouldNudgeRecovery({ authenticated: true, dismissed: false, hasRecovery, backup }));
    })();
  }, [authenticated, userId, secureStore, localStore, client]);

  const dismiss = useCallback(() => {
    setShow(false);
    if (!userId) return;
    void localStore?.setItem(recoveryNudgeDismissKey(userId), '1').catch(() => {
      /* storage unavailable — the banner still closes for this session */
    });
  }, [localStore, userId]);

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

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    banner: {
      marginHorizontal: 16,
      marginTop: 12,
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
