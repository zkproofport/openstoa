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
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { keyBackupHttp, recoverDevice, getDeviceMasterKey } from '../../crypto/mobileTransport';
import * as km from '../../crypto/keyManager';
import * as kb from '../../crypto/keyBackup';

// Byte-identical to the web PRF salt (src/lib/passkeyPrf.ts) so a synced passkey
// yields the same PRF output — hence the same master_key — on web and mobile.
const PRF_SALT_B64 = kb.b64(new TextEncoder().encode('openstoa-master-key-prf/v1'));

export function AccountRecoveryScreen() {
  const { colors } = useThemeColors();
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
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const genRecoveryCode = () =>
    run(async () => {
      if (!secureStore) throw new Error('Secure storage unavailable on this device.');
      const mk = await getDeviceMasterKey(secureStore);
      const code = await km.backupWithRecoveryCode(mk, http.postRecovery);
      setShownCode(code);
      setMsg('Recovery code created. Store it now — it is shown only once.');
      await refresh();
    });

  const addPasskey = () =>
    run(async () => {
      if (!secureStore || !host.passkeyPrf) throw new Error('Passkey recovery is unavailable on this device.');
      const mk = await getDeviceMasterKey(secureStore);
      const { credentialId, prfOutputB64 } = await host.passkeyPrf({ mode: 'create', saltB64: PRF_SALT_B64 });
      await km.backupWithPasskey(mk, credentialId, kb.unb64(prfOutputB64), http.postPasskey);
      setMsg('Passkey registered for recovery.');
      await refresh();
    });

  const recoverWithCode = () =>
    run(async () => {
      if (!secureStore) throw new Error('Secure storage unavailable on this device.');
      const code = recoverCode.trim();
      if (kb.recoveryCodeEntropyBits(code) < kb.RECOVERY_MIN_BITS) {
        throw new Error('That does not look like a valid recovery code.');
      }
      const mk = await km.recoverWithRecoveryCode(code, http.getBackup);
      if (!mk) throw new Error('Recovery failed — wrong code, or no recovery-code backup exists.');
      await recoverDevice(client, mk, secureStore, host.localStore);
      setRecoverCode('');
      setMsg('Recovered. Your chat history will reload.');
    });

  const recoverWithPasskeyFlow = () =>
    run(async () => {
      if (!secureStore || !host.passkeyPrf) throw new Error('Passkey recovery is unavailable on this device.');
      const { prfOutputB64 } = await host.passkeyPrf({ mode: 'get', saltB64: PRF_SALT_B64 });
      const mk = await km.recoverWithPasskey(kb.unb64(prfOutputB64), http.getBackup);
      if (!mk) throw new Error('Recovery failed — this passkey has no backup on file.');
      await recoverDevice(client, mk, secureStore, host.localStore);
      setMsg('Recovered with passkey. Your chat history will reload.');
    });

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Chat recovery</Text>
      <Text style={styles.sub}>
        End-to-end encrypted chat keys live only on your devices. Set up recovery so you can restore
        your history if you lose them. We never see your keys.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Status</Text>
        <Text style={[styles.status, { color: hasBackup ? colors.text.primary : colors.status.warning }]}>
          {state == null
            ? 'Checking…'
            : hasBackup
              ? `Recovery is set up${state.passkeys.length ? ` · ${state.passkeys.length} passkey(s)` : ''}${state.wrappedMaster ? ' · recovery code' : ''}.`
              : 'Not set up — you could permanently lose chat history if you lose your devices.'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Back up</Text>
        {!canBackup && <Text style={styles.sub}>Secure storage is unavailable, so backup is disabled here.</Text>}
        {canUsePasskey && (
          <TouchableOpacity style={styles.btn} disabled={busy || !canBackup} onPress={addPasskey}>
            <Text style={styles.btnText}>Register a passkey</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.btn} disabled={busy || !canBackup} onPress={genRecoveryCode}>
          <Text style={styles.btnText}>Generate a recovery code</Text>
        </TouchableOpacity>
        {shownCode && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.cardLabel}>Write this down. It is shown only once:</Text>
            <Text selectable style={styles.code}>
              {shownCode}
            </Text>
            <TouchableOpacity style={styles.btn} onPress={() => setShownCode(null)}>
              <Text style={styles.btnText}>I&apos;ve saved it</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recover on this device</Text>
        {canUsePasskey && (
          <TouchableOpacity style={styles.btn} disabled={busy} onPress={recoverWithPasskeyFlow}>
            <Text style={styles.btnText}>Recover with a passkey</Text>
          </TouchableOpacity>
        )}
        <TextInput
          value={recoverCode}
          onChangeText={setRecoverCode}
          placeholder="Enter recovery code"
          placeholderTextColor={colors.text.tertiary}
          autoCapitalize="characters"
          style={styles.input}
        />
        <TouchableOpacity style={styles.btn} disabled={busy || !recoverCode.trim()} onPress={recoverWithCode}>
          <Text style={styles.btnText}>Recover with code</Text>
        </TouchableOpacity>
      </View>

      {busy && <ActivityIndicator color={colors.brand.accent} style={{ marginTop: 8 }} />}
      {msg && <Text style={styles.ok}>{msg}</Text>}
      {err && <Text style={styles.error}>{err}</Text>}
      {session?.userId ? <Text style={styles.footId}>Identity {session.userId.slice(0, 8)}…</Text> : null}
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background.primary },
    content: { padding: 20 },
    title: { fontSize: 22, fontWeight: '800', color: colors.text.primary, letterSpacing: -0.4 },
    sub: { fontSize: 13, color: colors.text.tertiary, marginTop: 6, lineHeight: 18 },
    card: {
      marginTop: 16,
      padding: 16,
      borderRadius: 12,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary, marginBottom: 10 },
    cardLabel: { fontSize: 12, color: colors.text.tertiary },
    status: { fontSize: 15, marginTop: 4 },
    btn: {
      marginTop: 10,
      paddingVertical: 11,
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border.default,
      alignItems: 'center',
    },
    btnText: { fontSize: 14, color: colors.text.primary, fontWeight: '600' },
    code: {
      marginTop: 6,
      padding: 12,
      borderRadius: 8,
      backgroundColor: colors.background.primary,
      borderWidth: 1,
      borderColor: colors.border.default,
      color: colors.text.primary,
      fontFamily: 'Menlo',
      fontSize: 15,
      letterSpacing: 1,
    },
    input: {
      marginTop: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.primary,
      color: colors.text.primary,
      fontFamily: 'Menlo',
      fontSize: 14,
    },
    ok: { marginTop: 12, fontSize: 14, color: colors.status.success },
    error: { marginTop: 12, fontSize: 14, color: colors.status.danger },
    footId: { marginTop: 20, fontSize: 12, color: colors.text.tertiary, fontFamily: 'Menlo' },
  });
}
