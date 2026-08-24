import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';
// expo-image-picker is a native module — lazy-load to avoid crashing on
// stale Metro reloads where the native binary hasn't been rebuilt yet.
type ImagePickerModule = typeof import('expo-image-picker');
function loadImagePicker(): ImagePickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as ImagePickerModule;
  } catch {
    return null;
  }
}
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHost } from '@openstoa/miniapp-bridge';
import type { DomainBadgeStatus, SessionInfo } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from '../../i18n/language';
import { useLanguage } from '../../i18n/useLanguage';
import { buildDocsUrl } from '../../lib/docsLink';
import type { ProfileStackParamList } from '../../navigation/stacks/ProfileStack';
import { absolutizeMediaUrl } from '../../utils/absolutizeMediaUrl';
import { GatedImage } from '../../components/GatedImage';
import { isReservedNickname } from '../../lib/defaultNickname';
import { reportFailure } from '../../api/failure';

const NICKNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    scroll: {
      paddingVertical: 16,
    },
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
      marginBottom: 12,
    },
    // Profile image
    avatarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginBottom: 4,
    },
    avatarWrap: {
      position: 'relative',
    },
    avatarImage: {
      width: 72,
      height: 72,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.tertiary,
    },
    avatarPlaceholder: {
      width: 72,
      height: 72,
      borderRadius: RADIUS.pill,
      borderWidth: 2,
      borderColor: colors.border.default,
      borderStyle: 'dashed',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.secondary,
    },
    avatarPlaceholderText: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
      textAlign: 'center',
      lineHeight: 16,
    },
    avatarRemoveBtn: {
      position: 'absolute',
      top: -4,
      right: -4,
      width: 20,
      height: 20,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.status.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarRemoveText: {
      color: '#FFFFFF',
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
      lineHeight: 15,
    },
    avatarHint: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      lineHeight: 20,
    },
    avatarUploadBtn: {
      marginTop: 8,
      alignSelf: 'flex-start',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.strong,
    },
    avatarUploadBtnText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      fontWeight: '500',
    },
    // Nickname
    nicknameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    input: {
      flex: 1,
      height: 44,
      borderWidth: 1,
      borderColor: colors.border.strong,
      borderRadius: RADIUS.control,
      paddingHorizontal: 12,
      fontSize: TYPE_SCALE.body,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
    },
    inputValid: {
      borderColor: colors.status.success,
    },
    inputError: {
      borderColor: colors.status.danger,
    },
    validationText: {
      fontSize: TYPE_SCALE.caption,
      marginTop: 5,
    },
    validationOk: {
      color: colors.status.success,
    },
    validationErr: {
      color: colors.status.danger,
    },
    validationHint: {
      color: colors.text.tertiary,
    },
    charCount: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
      textAlign: 'right',
      marginTop: 4,
    },
    saveButton: {
      height: 44,
      paddingHorizontal: 18,
      borderRadius: RADIUS.control,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveButtonDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '700',
      color: colors.text.inverted,
    },
    domainBadgeInfo: {
      gap: 10,
    },
    domainBadgeActive: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    domainBadgeActiveText: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.primary,
    },
    activeDot: {
      width: 8,
      height: 8,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.status.success,
    },
    domainBadgeButton: {
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.status.danger,
    },
    domainBadgeButtonText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.status.danger,
    },
    domainBadgeOffText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      lineHeight: 20,
    },
    actionButton: {
      height: 48,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.strong,
      marginBottom: 10,
    },
    actionButtonText: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    actionButtonDanger: {
      backgroundColor: colors.status.danger,
      borderColor: colors.status.danger,
      marginBottom: 0,
    },
    actionButtonDangerText: {
      color: '#FFFFFF',
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    badgeChip: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.pill,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    badgeLabel: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    badgeEmpty: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },
    // Language picker — radio-style rows rather than a segmented control so
    // a long endonym (or a future third language) wraps down the list
    // instead of squeezing every option on the narrowest phone.
    languageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      minHeight: TOUCH_TARGET_MIN,
      paddingHorizontal: 12,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.strong,
      backgroundColor: colors.background.secondary,
      marginBottom: 8,
    },
    languageRowActive: {
      borderColor: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
    },
    languageLabel: {
      flexShrink: 1,
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    languageLabelActive: {
      color: colors.brand.primary,
    },
    languageCheck: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '700',
      color: colors.brand.primary,
    },
  });
}

export function EditProfileScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const host = useHost();
  // Typed against the stack this screen lives on, so the routes it pushes
  // (and their params) are checked instead of being cast through `never`.
  const navigation =
    useNavigation<NativeStackNavigationProp<ProfileStackParamList, 'EditProfile'>>();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { language, setLanguage } = useLanguage();
  // Null when the host reports an unusable base URL — the Docs row is hidden
  // in that case rather than opening a WebView on a broken address.
  const docsUrl = buildDocsUrl(host.getEnvironment().openstoaBaseUrl);

  const sessionQuery = useQuery<SessionInfo>({
    queryKey: ['session'],
    queryFn: () => client.get<SessionInfo>('/api/auth/session'),
  });

  const domainBadgeQuery = useQuery<DomainBadgeStatus>({
    queryKey: ['profile', 'domain-badge'],
    queryFn: async () => {
      const raw = await client.get<{ domains?: string[]; availableDomain?: string | null }>(
        '/api/profile/domain-badge',
      );
      const domains = raw.domains ?? [];
      return {
        domains,
        availableDomain: raw.availableDomain ?? null,
        enabled: domains.length > 0,
        domain: domains[0],
      };
    },
  });

  // API returns { profileImage } (see openstoa/src/app/api/profile/image/route.ts).
  // The previous `imageUrl` field name caused uploads to fail to render
  // because the query value was always undefined.
  const profileImageQuery = useQuery<{ profileImage: string | null }>({
    queryKey: ['profile', 'image'],
    queryFn: () => client.get<{ profileImage: string | null }>('/api/profile/image'),
  });

  const [nickname, setNickname] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);

  useEffect(() => {
    if (sessionQuery.data?.nickname) {
      setNickname(sessionQuery.data.nickname);
    }
  }, [sessionQuery.data?.nickname]);

  /*
   * Every rule `/api/profile/nickname` enforces, checked here first.
   *
   * The reserved-prefix rule was missing, and the screen said "Looks good" for
   * a name the server was always going to refuse — you only found out by
   * pressing Save and getting a 400. Held to the SAME `isReservedNickname` the
   * route calls (one twinned module, not a second copy of the rule), so the two
   * cannot answer differently.
   *
   * This is validation for the sake of the person typing, never a substitute
   * for the server's: the route still checks all of it, and a name that gets
   * past this one is still refused there and reported.
   */
  function validateNickname(value: string): string | null {
    if (value.length < 2) return t('openstoa.editProfile.nicknameRules.tooShort');
    if (value.length > 20) return t('openstoa.editProfile.nicknameRules.tooLong');
    if (!NICKNAME_RE.test(value)) return t('openstoa.editProfile.nicknameRules.charset');
    if (isReservedNickname(value)) return t('openstoa.editProfile.nicknameRules.reserved');
    return null;
  }

  const handleNicknameChange = useCallback((v: string) => {
    setNickname(v);
    setValidationError(v ? validateNickname(v) : null);
  }, []);

  // Profile image upload
  const pickAndUploadImage = useCallback(async () => {
    const ImagePicker = loadImagePicker();
    if (!ImagePicker) {
      Alert.alert('Image picker unavailable', 'The host app needs to be rebuilt to include expo-image-picker.');
      return;
    }
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets[0]) return;
    setImageUploading(true);
    try {
      const publicUrl = await client.uploadFile(result.assets[0].uri, { purpose: 'avatar' });
      await client.put('/api/profile/image', { imageUrl: publicUrl });
      void queryClient.invalidateQueries({ queryKey: ['profile', 'image'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    } catch (err) {
      Alert.alert('Upload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setImageUploading(false);
    }
  }, [client, queryClient]);

  const removeImageMutation = useMutation({
    mutationFn: () => client.delete('/api/profile/image'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profile', 'image'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (e) => {
      reportFailure(host, e, 'E9006');
    },
  });

  const handleRemoveImage = useCallback(() => {
    Alert.alert('Remove profile photo', 'Remove your profile photo?', [
      { text: t('openstoa.common.cancel'), style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => removeImageMutation.mutate(),
      },
    ]);
  }, [removeImageMutation, t]);

  const nicknameMutation = useMutation({
    mutationFn: (newNickname: string) =>
      client.put<{ nickname: string; token?: string }>('/api/profile/nickname', { nickname: newNickname }),
    onSuccess: async (data) => {
      // 0. Server reissues the JWT with the new nickname embedded in its
      //    claims. Web clients pick this up via Set-Cookie, but the mini-app
      //    is on Bearer auth — and openstoaClient keeps its own in-memory
      //    cachedToken on top of the host-persisted token. Update both
      //    via client.updateToken so the very next refetch carries the
      //    fresh claims instead of the stale Bearer. Await before
      //    invalidateQueries to avoid the refetch racing the write.
      if (data.token) {
        await client.updateToken(data.token);
      }
      // Push the change into all consumers right away:
      // 1. React Query cache so any mounted view (ProfileHome, FeedHome
      //    via author display, etc.) re-renders without waiting for the
      //    server refetch round-trip.
      queryClient.setQueryData<SessionInfo | undefined>(['session'], (prev) =>
        prev ? { ...prev, nickname: data.nickname } : prev,
      );
      // 2. In-memory session store — survives until next navigation away
      //    from OpenStoa, and primes any screen that reads from the store
      //    instead of the query.
      useOpenStoaSession.getState().setNickname(data.nickname);
      // 3. Finally a background invalidate so the next refetch reconciles
      //    any server-side derived fields (joinedAt, totalRecorded, etc.).
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      setNickname(data.nickname);
      Alert.alert(t('openstoa.editProfile.saved.title'), t('openstoa.editProfile.saved.message'));
    },
    onError: (e) => {
      /*
       * Say WHY. The server refuses a nickname for reasons it words for a
       * person — "That name is reserved.", "Nickname already taken" — and those
       * used to be flattened into a message string that nothing showed, so a
       * refusal arrived as a Save button that appeared not to work. When the
       * reason came from the server it is also shown under the field, because
       * the field is where the fix is.
       */
      const failure = reportFailure(host, e, 'E9003');
      if (failure.inline) setValidationError(failure.inline);
    },
  });

  const domainBadgeOptOutMutation = useMutation({
    mutationFn: () => client.delete('/api/profile/domain-badge'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profile', 'domain-badge'] });
    },
    onError: (e) => {
      reportFailure(host, e, 'E9004');
    },
  });

  const handleSaveNickname = useCallback(() => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      Alert.alert(t('openstoa.editProfile.error.title'), t('openstoa.editProfile.error.empty'));
      return;
    }
    const v = validateNickname(trimmed);
    if (v) {
      setValidationError(v);
      return;
    }
    if (trimmed === sessionQuery.data?.nickname) {
      Alert.alert(t('openstoa.editProfile.error.title'), t('openstoa.editProfile.error.same'));
      return;
    }
    nicknameMutation.mutate(trimmed);
  }, [nickname, sessionQuery.data?.nickname, nicknameMutation, t]);

  const handleDomainBadgeOptOut = useCallback(() => {
    Alert.alert(t('openstoa.editProfile.domainBadgeRemoveTitle'), t('openstoa.editProfile.domainBadgeRemoveMessage'), [
      { text: t('openstoa.common.cancel'), style: 'cancel' },
      {
        text: t('openstoa.editProfile.remove'),
        style: 'destructive',
        onPress: () => domainBadgeOptOutMutation.mutate(),
      },
    ]);
  }, [domainBadgeOptOutMutation, t]);

  const handleLogout = useCallback(() => {
    Alert.alert(t('openstoa.editProfile.logout.title'), t('openstoa.editProfile.logout.message'), [
      { text: t('openstoa.common.cancel'), style: 'cancel' },
      {
        text: t('openstoa.editProfile.logout.title'),
        style: 'destructive',
        onPress: async () => {
          await host.logoutFromOpenStoa();
          // Flip to guest mode rather than 'unknown'. This keeps OpenStoa
          // on the TabNavigator (phase stays 'ready' instead of dropping
          // back to Welcome), so the user lands on Feed as a guest
          // instead of being kicked all the way back to the host app.
          // The sessionLifecycle subscriber sees the authenticated→guest
          // crossing and clears queryClient cache synchronously.
          useOpenStoaSession.getState().setGuest();
          // `navigation` here is the ProfileStack navigator. Its parent
          // is the OpenStoaTabNavigator that owns FeedTab — one
          // `getParent()` is enough; the previous double-getParent was
          // reaching past the tab navigator into the host shell and
          // silently failing.
          navigation.popToTop();
          navigation.getParent()?.navigate('FeedTab' as never);
        },
      },
    ]);
  }, [host, t, navigation]);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      t('openstoa.editProfile.delete.title'),
      t('openstoa.editProfile.delete.message'),
      [
        { text: t('openstoa.common.cancel'), style: 'cancel' },
        {
          text: t('openstoa.common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await client.delete('/api/account');
              await host.logoutFromOpenStoa();
              // Account is gone — drop to guest mode and surface Feed so
              // the user sees a clean public state rather than being
              // ejected to the host with no acknowledgement of the
              // deletion. The lifecycle subscriber clears caches.
              useOpenStoaSession.getState().setGuest();
              try {
                navigation.popToTop();
                navigation.getParent()?.navigate('FeedTab' as never);
              } catch {
                // Navigation may have been unmounted; ignore.
              }
            } catch (e) {
              reportFailure(host, e, 'E9005');
            }
          },
        },
      ],
    );
  }, [client, host, t, navigation]);

  const domainBadge = domainBadgeQuery.data;
  // Cache-bust on every fetch so a fresh upload renders immediately instead
  // of the host's Image cache serving the stale URL from before the update.
  const rawProfileImage = absolutizeMediaUrl(profileImageQuery.data?.profileImage ?? null, client.getBaseUrl());
  const profileImageUrl = rawProfileImage
    ? `${rawProfileImage}${rawProfileImage.includes('?') ? '&' : '?'}t=${profileImageQuery.dataUpdatedAt}`
    : null;
  const isNicknameValid = nickname.trim().length >= 2 && !validationError;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Profile image section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('openstoa.profile.editPhoto')}</Text>
          <View style={styles.avatarRow}>
            <View style={styles.avatarWrap}>
              {profileImageUrl ? (
                <>
                  <GatedImage uri={profileImageUrl} style={styles.avatarImage} />
                  <TouchableOpacity
                    style={styles.avatarRemoveBtn}
                    onPress={handleRemoveImage}
                    disabled={removeImageMutation.isPending || imageUploading}
                  >
                    <Text style={styles.avatarRemoveText}>×</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={styles.avatarPlaceholder}
                  onPress={pickAndUploadImage}
                  disabled={imageUploading}
                  activeOpacity={0.7}
                >
                  {imageUploading ? (
                    <ActivityIndicator size="small" color={colors.text.tertiary} />
                  ) : (
                    <Text style={styles.avatarPlaceholderText}>{'Upload\nPhoto'}</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <View>
              <Text style={styles.avatarHint}>{'Profile photo (optional)\nAuto-resized to 200×200.'}</Text>
              {profileImageUrl ? (
                <TouchableOpacity
                  style={styles.avatarUploadBtn}
                  onPress={pickAndUploadImage}
                  disabled={imageUploading}
                >
                  {imageUploading ? (
                    <ActivityIndicator size="small" color={colors.text.secondary} />
                  ) : (
                    <Text style={styles.avatarUploadBtnText}>Change photo</Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </View>

        {/* Nickname section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('openstoa.editProfile.nickname')}</Text>
          <View style={styles.nicknameRow}>
            <TextInput
              style={[
                styles.input,
                validationError ? styles.inputError : isNicknameValid && nickname ? styles.inputValid : undefined,
              ]}
              value={nickname}
              onChangeText={handleNicknameChange}
              placeholder={t('openstoa.editProfile.nicknamePlaceholder')}
              placeholderTextColor={colors.text.tertiary}
              maxLength={20}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={handleSaveNickname}
            />
            <TouchableOpacity
              style={[
                styles.saveButton,
                (nicknameMutation.isPending || !isNicknameValid) && styles.saveButtonDisabled,
              ]}
              onPress={handleSaveNickname}
              disabled={nicknameMutation.isPending || !isNicknameValid}
            >
              {nicknameMutation.isPending ? (
                <ActivityIndicator size="small" color={colors.text.inverted} />
              ) : (
                <Text style={styles.saveButtonText}>{t('openstoa.editProfile.save')}</Text>
              )}
            </TouchableOpacity>
          </View>
          {validationError ? (
            <Text style={[styles.validationText, styles.validationErr]}>{validationError}</Text>
          ) : isNicknameValid && nickname ? (
            <Text style={[styles.validationText, styles.validationOk]}>Looks good</Text>
          ) : (
            <Text style={[styles.validationText, styles.validationHint]}>
              Letters, numbers, underscores only
            </Text>
          )}
          <Text style={styles.charCount}>{nickname.length}/20</Text>
        </View>

        {/* Domain badge section */}
        {domainBadge !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('openstoa.profile.domainBadge.label')}</Text>
            {domainBadge.enabled ? (
              <View style={styles.domainBadgeInfo}>
                <View style={styles.domainBadgeActive}>
                  <Text style={styles.domainBadgeActiveText}>
                    {domainBadge.domain ?? t('openstoa.editProfile.enabled')}
                  </Text>
                  <View style={styles.activeDot} />
                </View>
                <TouchableOpacity
                  style={[
                    styles.domainBadgeButton,
                    domainBadgeOptOutMutation.isPending && styles.saveButtonDisabled,
                  ]}
                  onPress={handleDomainBadgeOptOut}
                  disabled={domainBadgeOptOutMutation.isPending}
                >
                  {domainBadgeOptOutMutation.isPending ? (
                    <ActivityIndicator size="small" color={colors.status.danger} />
                  ) : (
                    <Text style={styles.domainBadgeButtonText}>{t('openstoa.editProfile.remove')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.domainBadgeInfo}>
                <Text style={styles.domainBadgeOffText}>
                  {t('openstoa.editProfile.domainOff')}{'\n'}
                  {t('openstoa.editProfile.domainOffHint')}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Notifications — the account-wide push switch (P-M), reconciled with
            the OS notification permission on the settings screen itself. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('NotificationSettings')}
          >
            <Text style={styles.actionButtonText}>Push notification settings</Text>
          </TouchableOpacity>
        </View>

        {/* Chat recovery (Phase 4 E2EE key backup / recovery) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Chat recovery</Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('AccountRecovery')}
          >
            <Text style={styles.actionButtonText}>Back up &amp; recover encrypted chat keys</Text>
          </TouchableOpacity>
        </View>

        {/* AI agent API keys — each key carries its own scope (design §7 consolidation) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('openstoa.apiKeys.title')}</Text>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('AiPermissions')}
          >
            <Text style={styles.actionButtonText}>{t('openstoa.apiKeys.yourKeys')}</Text>
          </TouchableOpacity>
        </View>

        {/* Language — the mini-app had no switcher at all, so a user whose
            host language was wrong had no way to correct it from inside
            OpenStoa. Labels are endonyms (see i18n/language.ts). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('openstoa.editProfile.language')}</Text>
          {SUPPORTED_LANGUAGES.map((lang) => {
            const isActive = language === lang;
            return (
              <TouchableOpacity
                key={lang}
                style={[styles.languageRow, isActive && styles.languageRowActive]}
                onPress={() => setLanguage(lang)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={LANGUAGE_LABELS[lang]}
              >
                <Text
                  style={[styles.languageLabel, isActive && styles.languageLabelActive]}
                  numberOfLines={1}
                >
                  {LANGUAGE_LABELS[lang]}
                </Text>
                {isActive ? <Text style={styles.languageCheck}>✓</Text> : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Docs — the web guide had no entry point anywhere in the mini-app.
            Opens in the in-app WebView per the project-wide rule that
            outbound http(s) links never punt to the system browser. */}
        {docsUrl ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('openstoa.editProfile.help')}</Text>
            <TouchableOpacity
              style={styles.actionButton}
              accessibilityRole="link"
              onPress={() =>
                navigation.navigate('InAppBrowser', {
                  url: docsUrl,
                  title: t('openstoa.editProfile.docs'),
                })
              }
            >
              <Text style={styles.actionButtonText}>{t('openstoa.editProfile.docs')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Account actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('openstoa.editProfile.account')}</Text>
          <TouchableOpacity style={styles.actionButton} onPress={handleLogout}>
            <Text style={styles.actionButtonText}>{t('openstoa.editProfile.logout.title')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonDanger]}
            onPress={handleDeleteAccount}
          >
            <Text style={[styles.actionButtonText, styles.actionButtonDangerText]}>
              {t('openstoa.editProfile.delete.title')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
