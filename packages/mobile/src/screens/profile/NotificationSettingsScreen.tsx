import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { registerPushNow } from '../../hooks/pushRegistration';
import {
  readOsPushState,
  applyRegistrationOutcome,
  type OsPushState,
} from '../../hooks/pushPermission';
import { useThemeColors } from '../../theme/ThemeContext';
import { useTranslation } from 'react-i18next';
import type { ThemeColors } from '../../theme/colors';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';

/**
 * Notification settings (P-M) — the in-app GLOBAL push switch, reconciled with
 * the operating system's own notification permission.
 *
 * Two independent gates decide whether a chat message reaches the lock screen:
 *   1. the OS permission (device-local, only the user can grant it), and
 *   2. this account-wide server preference (`/api/push/preferences`).
 * Turning the in-app switch on cannot grant (1), so when the OS has blocked
 * notifications the screen SAYS SO and offers to open system settings instead
 * of flipping a switch that would silently do nothing.
 *
 * Per-topic muting lives in each chat room's header (see TopicMuteButton) —
 * the same split the web client uses.
 */

interface PushPreferences {
  enabled: boolean;
  mutedTopicIds: string[];
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background.secondary },
    scroll: { paddingVertical: 16 },
    section: {
      backgroundColor: colors.background.primary,
      marginHorizontal: 16,
      marginBottom: 16,
      borderRadius: RADIUS.card,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    sectionTitle: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.text.tertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    intro: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.secondary, lineHeight: 20 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 6,
    },
    rowLabel: { fontSize: TYPE_SCALE.body, color: colors.text.primary, flex: 1, marginRight: 12 },
    rowHint: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary, marginTop: 6, lineHeight: 18 },
    blockedBox: {
      marginTop: 12,
      padding: 12,
      borderRadius: RADIUS.card,
      backgroundColor: 'rgba(239,68,68,0.08)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(239,68,68,0.35)',
    },
    blockedText: { fontSize: TYPE_SCALE.bodySmall, color: '#ef4444', lineHeight: 19 },
    settingsButton: {
      marginTop: 10,
      height: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.control,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brand.primary,
    },
    settingsButtonText: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '700', color: colors.text.inverted },
    errorBox: { marginTop: 12 },
    errorText: { fontSize: TYPE_SCALE.caption, color: '#ef4444', lineHeight: 19 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  });
}

export function NotificationSettingsScreen() {
  const client = useOpenStoaClient();
  const host = useHost();
  const queryClient = useQueryClient();
  const userId = useOpenStoaSession((s) => s.userId);
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();

  const prefsQuery = useQuery<PushPreferences>({
    queryKey: ['push', 'preferences'],
    queryFn: () => client.get<PushPreferences>('/api/push/preferences'),
  });

  // OS permission, read WITHOUT prompting. `unknown` on a host that cannot
  // report it — in that case we make no claim about the system state.
  const [osState, setOsState] = useState<OsPushState>('unknown');
  useEffect(() => {
    let cancelled = false;
    void readOsPushState(host).then((s) => {
      if (!cancelled) setOsState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  const saveMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      client.patch<PushPreferences>('/api/push/preferences', { enabled }),
    onSuccess: async (data, enabled) => {
      // Trust the server's echo over the requested value.
      queryClient.setQueryData<PushPreferences>(['push', 'preferences'], data);
      if (!enabled) return;
      // Turning it ON is also the moment to make sure this device actually has
      // a token registered — the once-per-session automatic attempt may have
      // run (and been skipped or declined) long before the user got here.
      const outcome = await registerPushNow(userId ?? '', host, client);
      setOsState((prev) => applyRegistrationOutcome(prev, outcome));
    },
    onError: (e) => {
      Alert.alert(t('openstoa.common.saveFailed'), e instanceof Error ? e.message : String(e));
    },
  });

  const openSystemSettings = useCallback(() => {
    // RN's own deep link into THIS app's OS settings page. Not routed through
    // the in-app WebView on purpose: it is a native settings intent, not an
    // http(s) URL the WebView could render.
    void Linking.openSettings().catch(() => {
      Alert.alert(
        t('openstoa.notificationSettings.openSettingsFailedTitle'),
        t('openstoa.notificationSettings.openSettingsFailedBody'),
      );
    });
  }, []);

  if (prefsQuery.isLoading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="small" color={colors.brand.primary} />
      </View>
    );
  }

  if (prefsQuery.isError) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={[styles.intro, { paddingHorizontal: 32, textAlign: 'center' }]}>
          {t('openstoa.notifications.loadFailed')}
        </Text>
      </View>
    );
  }

  const enabled = prefsQuery.data?.enabled !== false;
  const mutedCount = prefsQuery.data?.mutedTopicIds?.length ?? 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scroll}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.notificationSettings.sectionTitle')}</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('openstoa.notificationSettings.pushLabel')}</Text>
          <Switch
            value={enabled}
            disabled={saveMutation.isPending}
            onValueChange={(next) => saveMutation.mutate(next)}
            trackColor={{ true: colors.brand.primary, false: colors.border.strong }}
          />
        </View>
        <Text style={styles.rowHint}>
          {enabled
            ? t('openstoa.notificationSettings.onHint')
            : t('openstoa.notificationSettings.offHint')}
        </Text>
        <Text style={styles.rowHint}>
          {t('openstoa.notificationSettings.accountWide')}
          {mutedCount > 0 ? t('openstoa.notificationSettings.mutedCount', { count: mutedCount }) : ''}
        </Text>

        {osState === 'blocked' && (
          <View style={styles.blockedBox}>
            <Text style={styles.blockedText}>{t('openstoa.notificationSettings.blocked')}</Text>
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={openSystemSettings}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.settingsButtonText}>{t('openstoa.notificationSettings.openSystemSettings')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {osState === 'prompt' && enabled && (
          <Text style={styles.rowHint}>
            {t('openstoa.notifications.permissionNotAsked')}
          </Text>
        )}
      </View>

      {Platform.OS === 'ios' ? <View style={{ height: 24 }} /> : null}
    </ScrollView>
  );
}
