/**
 * Phase 4 account-recovery screen (mini-app). Mirrors the web AccountRecovery
 * component: back up the E2EE chat master_key via a synced passkey (host WebAuthn
 * PRF bridge) and/or a recovery code, and recover it on a fresh device. The
 * recovery salt is byte-identical to the web client's, so the SAME synced passkey
 * recovers the SAME master_key across web and mobile (design §6.2/§6.4).
 *
 * The host must implement HostApi.passkeyPrf (react-native-passkeys) for the
 * passkey path; without it only the recovery-code path is offered. The server
 * only ever stores wrapped ciphertext (no escrow, SI-8).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { keyBackupHttp, recoverDevice, getDeviceMasterKey, uploadTakKeychainNow } from '../../crypto/mobileTransport';
import * as km from '../../crypto/keyManager';
import * as kb from '../../crypto/keyBackup';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';

// Byte-identical to the web PRF salt (src/lib/passkeyPrf.ts) so a synced passkey
// yields the same PRF output — hence the same master_key — on web and mobile.
const PRF_SALT_B64 = kb.b64(new TextEncoder().encode('openstoa-master-key-prf/v1'));

export function AccountRecoveryScreen() {
  const { colors } = useThemeColors();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const client = useOpenStoaClient();
  const host = useHost();
  const session = useOpenStoaSession();
  const http = keyBackupHttp(client);

  const secureStore = host.secureStore;
  const canUsePasskey = typeof host.passkeyPrf === 'function';
  const canBackup = !!secureStore; // master_key needs the host secure store

  const [state, setState] = useState<km.KeyBackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [recoverCode, setRecoverCode] = useState('');
  // Recovery succeeded but the chat-key snapshot did not go up. NOT an error —
  // the master_key wrap is real and worth keeping — but it must be VISIBLE,
  // because the resulting half-built state is exactly the reported bug.
  const [partial, setPartial] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await http.getBackup());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [http]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasBackup = !!state && (!!state.wrappedMaster || state.passkeys.length > 0);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setPartial(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Setting recovery up IS the user saying "back up what I hold now".
   *
   * Without this, `tak_key_backups` was only ever written by the TAK key-CHANGE
   * hook, so a user who already held their keys and then registered a passkey
   * got a `key_backups` row and NOTHING to restore: recovery came back and
   * unlocked nothing, and opening a chat wrote no new key so the change hook
   * never fired again.
   *
   * NEVER rolls the master_key wrap back. A failed keychain upload leaves the
   * account strictly better off than no recovery at all — the honest move is to
   * keep the wrap and say plainly that the chat keys have not gone up yet.
   */
  async function backUpKeychain(): Promise<void> {
    if (!secureStore) return;
    switch (await uploadTakKeychainNow(client, secureStore, host.localStore)) {
      case 'untrusted':
        setPartial(t('openstoa.recovery.keychainUntrusted'));
        break;
      case 'failed':
        setPartial(t('openstoa.recovery.keychainUploadFailed'));
        break;
      // 'uploaded' — done. 'empty' — no chat keys on this device yet, so there
      // is genuinely nothing to snapshot; the wrap alone is the right outcome.
    }
  }

  const genRecoveryCode = () =>
    run(async () => {
      if (!secureStore) throw new Error('Secure storage unavailable on this device.');
      const mk = await getDeviceMasterKey(secureStore);
      const code = await km.backupWithRecoveryCode(mk, http.postRecovery);
      setShownCode(code);
      setMsg('Recovery code created. Store it now — it is shown only once.');
      await backUpKeychain();
      await refresh();
    });

  const addPasskey = () =>
    run(async () => {
      if (!secureStore || !host.passkeyPrf) throw new Error('Passkey recovery is unavailable on this device.');
      const mk = await getDeviceMasterKey(secureStore);
      const { credentialId, prfOutputB64 } = await host.passkeyPrf({ mode: 'create', saltB64: PRF_SALT_B64 });
      await km.backupWithPasskey(mk, credentialId, kb.unb64(prfOutputB64), http.postPasskey);
      setMsg('Passkey registered for recovery.');
      await backUpKeychain();
      await refresh();
    });

  /**
   * ONE PLACE TO RECOVER, so a fourth way cannot be added that skips a step.
   *
   * Telling the open rooms is NOT done here, and the first attempt at this
   * did it here and did not work. `recoverDevice` raises a counter the rooms
   * subscribe to; a room re-renders on the bump — which is when it picks up
   * the rebuilt MLS session — and only then asks for its history again.
   * Invalidating from this screen instead refetches while the room still
   * holds the session from before the recovery, so the rows come back locked
   * and the entry is no longer stale. See the counter in `mobileTransport`.
   *
   * What this function is for is narrower and still worth having: every way
   * to recover calls `recoverDevice` through here and nowhere else, so a
   * fourth way cannot be added that skips whatever else recovery grows.
   * There is a guard on that.
   */
  const recoverAndReopenRooms = useCallback(
    async (masterKey: Uint8Array) => {
      if (!secureStore) throw new Error('Secure storage unavailable on this device.');
      return recoverDevice(client, masterKey, secureStore, host.localStore);
    },
    [client, secureStore, host.localStore],
  );

  const recoverWithCode = () =>
    run(async () => {
      if (!secureStore) throw new Error('Secure storage unavailable on this device.');
      const code = recoverCode.trim();
      if (kb.recoveryCodeEntropyBits(code) < kb.RECOVERY_MIN_BITS) {
        throw new Error('That does not look like a valid recovery code.');
      }
      const mk = await km.recoverWithRecoveryCode(code, http.getBackup);
      if (!mk) throw new Error('Recovery failed — wrong code, or no recovery-code backup exists.');
      const outcome = await recoverAndReopenRooms(mk);
      setRecoverCode('');
      /*
       * NOT "your chat history will reload" — that promise is false for three
       * of the four tiers.
       *
       * The backup holds the keys the OTHER device actually received. Epochs
       * that advanced while it was off never reached it, so they were never in
       * the manifest and are not in the blob. Public rooms come back in full
       * (the server holds the archive root); private, secret and DM rooms come
       * back only as far as that snapshot, and the rest arrives when another
       * member's device grants those epochs — see `grantPrivateHistory`.
       *
       * Saying "history will reload" and then showing empty rooms is how a
       * person concludes the app lost their messages, which is worse than the
       * truth and harder to undo.
       */
      setMsg(t('openstoa.recovery.recovered'));
      /*
       * The chat keys could not be READ this time. Say that, rather than the
       * gap notice, which describes a different and much smaller shortfall.
       * The master key is in either way — see `RecoverOutcome`.
       */
      setPartial(
        outcome === 'keys-pending'
          ? t('openstoa.recovery.keysPending')
          : t('openstoa.recovery.gapNotice'),
      );
    });

  const recoverWithPasskeyFlow = () =>
    run(async () => {
      if (!secureStore || !host.passkeyPrf) throw new Error('Passkey recovery is unavailable on this device.');
      const { prfOutputB64 } = await host.passkeyPrf({ mode: 'get', saltB64: PRF_SALT_B64 });
      const mk = await km.recoverWithPasskey(kb.unb64(prfOutputB64), http.getBackup);
      if (!mk) throw new Error(t('openstoa.recovery.passkeyNoBackup'));
      await recoverAndReopenRooms(mk);
      setMsg(t('openstoa.recovery.recovered'));
      setPartial(t('openstoa.recovery.gapNotice'));
    });

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{t('openstoa.recovery.title')}</Text>
      <Text style={styles.sub}>{t('openstoa.recovery.intro')}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t('openstoa.recovery.statusLabel')}</Text>
        <Text style={[styles.status, { color: hasBackup ? colors.text.primary : colors.status.warning }]}>
          {state == null
            ? t('openstoa.recovery.statusChecking')
            : hasBackup
              ? `${[
                  t('openstoa.recovery.statusSetUp'),
                  ...(state.passkeys.length
                    ? [t('openstoa.recovery.statusPasskeys', { count: state.passkeys.length })]
                    : []),
                  ...(state.wrappedMaster ? [t('openstoa.recovery.statusCode')] : []),
                ].join(' · ')}.`
              : t('openstoa.recovery.statusNotSetUp')}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('openstoa.recovery.backUpTitle')}</Text>
        {!canBackup && <Text style={styles.sub}>{t('openstoa.recovery.secureUnavailable')}</Text>}
        {canUsePasskey && (
          <TouchableOpacity style={styles.btn} disabled={busy || !canBackup} onPress={addPasskey}>
            <Text style={styles.btnText}>{t('openstoa.recovery.registerPasskey')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.btn} disabled={busy || !canBackup} onPress={genRecoveryCode}>
          <Text style={styles.btnText}>{t('openstoa.recovery.generateCode')}</Text>
        </TouchableOpacity>
        {shownCode && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.cardLabel}>{t('openstoa.recovery.writeItDown')}</Text>
            <Text selectable style={styles.code}>
              {shownCode}
            </Text>
            <TouchableOpacity style={styles.btn} onPress={() => setShownCode(null)}>
              <Text style={styles.btnText}>{t('openstoa.recovery.savedIt')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('openstoa.recovery.recoverTitle')}</Text>
        {canUsePasskey && (
          <TouchableOpacity style={styles.btn} disabled={busy} onPress={recoverWithPasskeyFlow}>
            <Text style={styles.btnText}>{t('openstoa.recovery.recoverWithPasskey')}</Text>
          </TouchableOpacity>
        )}
        <TextInput
          value={recoverCode}
          onChangeText={setRecoverCode}
          placeholder={t('openstoa.recovery.codePlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          autoCapitalize="characters"
          style={styles.input}
        />
        <TouchableOpacity style={styles.btn} disabled={busy || !recoverCode.trim()} onPress={recoverWithCode}>
          <Text style={styles.btnText}>{t('openstoa.recovery.recoverWithCode')}</Text>
        </TouchableOpacity>
      </View>

      {busy && <ActivityIndicator color={colors.brand.accent} style={{ marginTop: 8 }} />}
      {msg && <Text style={styles.ok}>{msg}</Text>}
      {/* Warning, not danger: the recovery key IS saved. What did not happen is
          the chat-key snapshot, and saying so is the whole point — a silent
          half-built recovery is the defect this screen was reported for. */}
      {partial && <Text style={styles.partial}>{partial}</Text>}
      {err && <Text style={styles.error}>{err}</Text>}
      {session?.userId ? <Text style={styles.footId}>{t('openstoa.recovery.identity', { id: session.userId.slice(0, 8) })}</Text> : null}
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background.primary },
    content: { padding: 20 },
    title: { fontSize: TYPE_SCALE.headingSmall, fontWeight: '800', color: colors.text.primary, letterSpacing: -0.4 },
    sub: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary, marginTop: 6, lineHeight: 18 },
    card: {
      marginTop: 16,
      padding: 16,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    cardTitle: { fontSize: TYPE_SCALE.body, fontWeight: '700', color: colors.text.primary, marginBottom: 10 },
    cardLabel: { fontSize: TYPE_SCALE.label, color: colors.text.tertiary },
    status: { fontSize: TYPE_SCALE.body, marginTop: 4 },
    btn: {
      marginTop: 10,
      paddingVertical: 11,
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
      alignItems: 'center',
    },
    btnText: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.primary, fontWeight: '600' },
    code: {
      marginTop: 6,
      padding: 12,
      borderRadius: RADIUS.control,
      backgroundColor: colors.background.primary,
      borderWidth: 1,
      borderColor: colors.border.default,
      color: colors.text.primary,
      fontFamily: 'Menlo',
      fontSize: TYPE_SCALE.body,
      letterSpacing: 1,
    },
    input: {
      marginTop: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.primary,
      color: colors.text.primary,
      fontFamily: 'Menlo',
      fontSize: TYPE_SCALE.body,
    },
    ok: { marginTop: 12, fontSize: TYPE_SCALE.bodySmall, color: colors.status.success },
    partial: { marginTop: 8, fontSize: TYPE_SCALE.bodySmall, color: colors.status.warning, lineHeight: 18 },
    error: { marginTop: 12, fontSize: TYPE_SCALE.bodySmall, color: colors.status.danger },
    footId: { marginTop: 20, fontSize: TYPE_SCALE.label, color: colors.text.tertiary, fontFamily: 'Menlo' },
  });
}
