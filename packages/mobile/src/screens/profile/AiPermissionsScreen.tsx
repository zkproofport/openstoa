import { userFacingError } from '../../i18n/userFacingError';
import type { TFunction } from 'i18next';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useTranslation } from 'react-i18next';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';

// Lazy-required exactly like ChatRoomScreen's clipboard usage — the native
// module ships with the host app, not this package, so a fresh dev rebuild
// that hasn't picked it up yet must not crash the screen.
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default;
function loadClipboard(): ClipboardModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@react-native-clipboard/clipboard') as { default: ClipboardModule }).default;
  } catch {
    return null;
  }
}

// AI capability is scoped to the API key itself — GitHub-PAT style. There is
// no account-wide grant any more (design §7 consolidation, 2026-07-30):
// `GET/PUT /api/profile/ai-permissions` are retired (410). Every isAI session
// is authenticated with `Authorization: Bearer osk_...`, and the key's OWN
// cmd/historyGrant are the only thing the server ever consults
// (`requireAiCapability` in the web app's `src/lib/aiPermissions.ts`).
interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  isAI: boolean;
  cmd: string[];
  historyGrant: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface ApiKeysResponse {
  apiKeys: ApiKeyMeta[];
  allowedCmd?: string[];
}
interface CreateKeyResponse {
  rawKey: string;
  key: ApiKeyMeta;
}

// Human labels for the capability paths. Any cmd not listed falls back to its
// raw path, so a newly-added server capability still renders (just unlabelled).
// Mirrors the web app's `src/lib/apiKeyForm.ts` CMD_LABELS.
const CMD_LABELS: Record<string, string> = {
  '/openstoa/topic/read': 'openstoa.apiKeys.capabilities.readTopics',
  '/openstoa/topic/create': 'openstoa.apiKeys.capabilities.createTopics',
  '/openstoa/topic/edit': 'openstoa.apiKeys.capabilities.editTopics',
  '/openstoa/topic/delete': 'openstoa.apiKeys.capabilities.deleteTopics',
  '/openstoa/topic/manage-members': 'openstoa.apiKeys.capabilities.manageMembers',
  '/openstoa/post/react': 'openstoa.apiKeys.capabilities.reactPosts',
  '/openstoa/post/record': 'openstoa.apiKeys.capabilities.recordPosts',
  '/openstoa/comment/delete': 'openstoa.apiKeys.capabilities.deleteComments',
  '/openstoa/upload/write': 'openstoa.apiKeys.capabilities.uploadImages',
  '/openstoa/upload/delete': 'openstoa.apiKeys.capabilities.deleteUploads',
  '/openstoa/media/read': 'openstoa.apiKeys.capabilities.readMedia',
  '/openstoa/notification/read': 'openstoa.apiKeys.capabilities.readNotifications',
  '/openstoa/notification/write': 'openstoa.apiKeys.capabilities.writeNotifications',
  '/openstoa/chat/manage-keys': 'openstoa.apiKeys.capabilities.manageChatKeys',

  '/openstoa/topic/join': 'openstoa.apiKeys.capabilities.topicJoin',
  '/openstoa/topic/leave': 'openstoa.apiKeys.capabilities.topicLeave',
  '/openstoa/post/read': 'openstoa.apiKeys.capabilities.postRead',
  '/openstoa/post/write': 'openstoa.apiKeys.capabilities.postWrite',
  '/openstoa/post/delete': 'openstoa.apiKeys.capabilities.postDelete',
  '/openstoa/comment/read': 'openstoa.apiKeys.capabilities.commentRead',
  '/openstoa/comment/write': 'openstoa.apiKeys.capabilities.commentWrite',
  '/openstoa/chat/read': 'openstoa.apiKeys.capabilities.chatRead',
  '/openstoa/chat/send': 'openstoa.apiKeys.capabilities.chatSend',
  '/openstoa/profile/read': 'openstoa.apiKeys.capabilities.profileRead',
  '/openstoa/profile/edit': 'openstoa.apiKeys.capabilities.profileEdit',
  '/ai/summarize': 'openstoa.apiKeys.capabilities.summarize',
  '/ai/search': 'openstoa.apiKeys.capabilities.search',
};

// History (chat archive) scope choices — a subset of the server's isValidTakScope
// grammar (none | Nd | since_epoch:N | full) that covers the common cases.
const HISTORY_SCOPES: { key: string; label: string }[] = [
  { key: 'none', label: 'openstoa.apiKeys.historyScopes.none' },
  { key: '7d', label: 'openstoa.apiKeys.historyScopes.7d' },
  { key: '30d', label: 'openstoa.apiKeys.historyScopes.30d' },
  { key: 'full', label: 'openstoa.apiKeys.historyScopes.full' },
];

const MAX_NAME_LEN = 100;

function scopeLabel(scope: string, t: TFunction): string {
  const choice = HISTORY_SCOPES.find((s) => s.key === scope);
  return choice ? t(choice.label) : scope;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** Orders `selected` by the server's `allowedCmd` catalogue — stable payload. */
function orderedCmd(allowedCmd: string[], selected: Set<string>): string[] {
  return allowedCmd.filter((c) => selected.has(c));
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
    intro: { fontSize: TYPE_SCALE.caption, color: colors.text.secondary, lineHeight: 20, marginBottom: 4 },
    capRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    capLabel: { fontSize: TYPE_SCALE.body, color: colors.text.primary, flex: 1, marginRight: 12 },
    capPath: { fontSize: TYPE_SCALE.label, color: colors.text.tertiary },
    scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
    scopeChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: RADIUS.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    scopeChipActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
    scopeChipLabel: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.primary },
    scopeChipLabelActive: { color: colors.text.inverted, fontWeight: '600' },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
      borderRadius: RADIUS.control,
      paddingHorizontal: 12,
      paddingVertical: Platform.OS === 'ios' ? 10 : 8,
      fontSize: TYPE_SCALE.body, // below 16 iOS Safari-in-WebView-style zoom isn't relevant natively, but keep parity with web's floor
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
    },
    saveButton: {
      height: 48,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brand.primary,
    },
    saveButtonDisabled: { opacity: 0.5 },
    saveButtonText: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '700', color: colors.text.inverted },
    secondaryButton: {
      height: 44,
      borderRadius: RADIUS.card,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    secondaryButtonText: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '600', color: colors.text.primary },
    dangerButton: {
      height: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.control,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
      backgroundColor: colors.status.danger + '1a',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.status.danger,
    },
    dangerButtonText: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '600', color: colors.status.danger },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    keyRow: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
      padding: 12,
      marginBottom: 10,
    },
    keyRowRevoked: { opacity: 0.5 },
    keyRowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    keyName: { fontSize: TYPE_SCALE.body, fontWeight: '600', color: colors.text.primary },
    keyPrefix: { fontSize: TYPE_SCALE.label, color: colors.text.tertiary, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
    keyMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
    keyMetaText: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary },
    keyActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    rawKeyBox: {
      backgroundColor: colors.background.secondary,
      borderRadius: RADIUS.control,
      padding: 12,
      marginTop: 8,
    },
    rawKeyText: { fontSize: TYPE_SCALE.caption, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), color: colors.text.primary },
  });
}

/** Shared capability toggle list — used by both the create form and the edit-in-place form. */
function CapabilityToggles({
  allowedCmd,
  selected,
  onToggle,
  styles,
  colors,
}: {
  allowedCmd: string[];
  selected: Set<string>;
  onToggle: (cmd: string) => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const { t } = useTranslation();
  return (
    <>
      {allowedCmd.map((cmd) => (
        <View key={cmd} style={styles.capRow}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={styles.capLabel}>{CMD_LABELS[cmd] ? t(CMD_LABELS[cmd]) : cmd}</Text>
            <Text style={styles.capPath}>{cmd}</Text>
          </View>
          <Switch
            value={selected.has(cmd)}
            onValueChange={() => onToggle(cmd)}
            trackColor={{ true: colors.brand.primary, false: colors.border.strong }}
          />
        </View>
      ))}
    </>
  );
}

/** Shared history-scope chip row. */
function HistoryScopeChips({
  value,
  onChange,
  styles,
}: {
  value: string;
  onChange: (v: string) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.scopeRow}>
      {HISTORY_SCOPES.map((s) => {
        const active = value === s.key;
        return (
          <TouchableOpacity
            key={s.key}
            style={[styles.scopeChip, active && styles.scopeChipActive]}
            onPress={() => onChange(s.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.scopeChipLabel, active && styles.scopeChipLabelActive]}>{t(s.label)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function AiPermissionsScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const keysQuery = useQuery<ApiKeysResponse>({
    queryKey: ['profile', 'api-keys'],
    queryFn: () => client.get<ApiKeysResponse>('/api/profile/api-keys'),
  });
  const allowedCmd = keysQuery.data?.allowedCmd ?? [];
  const keys = keysQuery.data?.apiKeys ?? [];

  // ── Create form ────────────────────────────────────────────────────────
  const [newName, setNewName] = useState('');
  const [newCmd, setNewCmd] = useState<Set<string>>(new Set());
  const [newHistory, setNewHistory] = useState('none');
  const [rawKey, setRawKey] = useState<string | null>(null);
  const toggleNewCmd = useCallback((cmd: string) => setNewCmd((prev) => toggleInSet(prev, cmd)), []);

  const createMutation = useMutation({
    mutationFn: (body: { name: string; cmd: string[]; historyGrant: string }) =>
      client.post<CreateKeyResponse>('/api/profile/api-keys', body),
    onSuccess: (data) => {
      setRawKey(data.rawKey);
      queryClient.setQueryData<ApiKeysResponse | undefined>(['profile', 'api-keys'], (prev) =>
        prev ? { ...prev, apiKeys: [data.key, ...prev.apiKeys] } : prev,
      );
      setNewName('');
      setNewCmd(new Set());
      setNewHistory('none');
    },
    onError: (e) => {
      Alert.alert(t('openstoa.apiKeys.createFailedTitle'), userFacingError(e, t));
    },
  });

  const nameTrimmed = newName.trim();
  const canCreate = nameTrimmed.length > 0 && nameTrimmed.length <= MAX_NAME_LEN && !createMutation.isPending;
  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    createMutation.mutate({ name: nameTrimmed, cmd: orderedCmd(allowedCmd, newCmd), historyGrant: newHistory });
  }, [canCreate, createMutation, nameTrimmed, allowedCmd, newCmd, newHistory]);

  const copyRawKey = useCallback(() => {
    if (!rawKey) return;
    const Clipboard = loadClipboard();
    if (!Clipboard) {
      Alert.alert(t('openstoa.apiKeys.clipboardUnavailableTitle'), t('openstoa.apiKeys.clipboardUnavailableMessage'));
      return;
    }
    Clipboard.setString(rawKey);
  }, [rawKey, t]);

  // ── Per-key edit ───────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCmd, setEditCmd] = useState<Set<string>>(new Set());
  const [editHistory, setEditHistory] = useState('none');
  const toggleEditCmd = useCallback((cmd: string) => setEditCmd((prev) => toggleInSet(prev, cmd)), []);

  const startEdit = useCallback((k: ApiKeyMeta) => {
    setEditingId(k.id);
    setEditCmd(new Set(k.cmd));
    setEditHistory(k.historyGrant || 'none');
  }, []);
  const cancelEdit = useCallback(() => setEditingId(null), []);

  const editMutation = useMutation({
    mutationFn: ({ keyId, cmd, historyGrant }: { keyId: string; cmd: string[]; historyGrant: string }) =>
      client.patch<{ key: ApiKeyMeta }>(`/api/profile/api-keys/${keyId}`, { cmd, historyGrant }),
    onSuccess: (data) => {
      queryClient.setQueryData<ApiKeysResponse | undefined>(['profile', 'api-keys'], (prev) =>
        prev ? { ...prev, apiKeys: prev.apiKeys.map((k) => (k.id === data.key.id ? data.key : k)) } : prev,
      );
      setEditingId(null);
    },
    onError: (e) => {
      Alert.alert(t('openstoa.apiKeys.editFailedTitle'), userFacingError(e, t));
    },
  });
  const saveEdit = useCallback(
    (keyId: string) => editMutation.mutate({ keyId, cmd: orderedCmd(allowedCmd, editCmd), historyGrant: editHistory }),
    [editMutation, allowedCmd, editCmd, editHistory],
  );

  // ── Revoke ─────────────────────────────────────────────────────────────
  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => client.delete<{ revoked: boolean; id: string }>(`/api/profile/api-keys/${keyId}`),
    onSuccess: (data) => {
      queryClient.setQueryData<ApiKeysResponse | undefined>(['profile', 'api-keys'], (prev) =>
        prev
          ? { ...prev, apiKeys: prev.apiKeys.map((k) => (k.id === data.id ? { ...k, revokedAt: new Date().toISOString() } : k)) }
          : prev,
      );
      setEditingId((cur) => (cur === data.id ? null : cur));
    },
    onError: (e) => {
      Alert.alert(t('openstoa.apiKeys.revokeFailedTitle'), userFacingError(e, t));
    },
  });
  const confirmRevoke = useCallback(
    (keyId: string, name: string) => {
      Alert.alert(
        t('openstoa.apiKeys.revokeConfirmTitle'),
        t('openstoa.apiKeys.revokeConfirmMessage', { name }),
        [
          { text: t('openstoa.common.cancel'), style: 'cancel' },
          { text: t('openstoa.apiKeys.revoke'), style: 'destructive', onPress: () => revokeMutation.mutate(keyId) },
        ],
      );
    },
    [revokeMutation, t],
  );

  if (keysQuery.isLoading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="small" color={colors.brand.primary} />
      </View>
    );
  }

  if (keysQuery.isError) {
    return (
      <View style={[styles.root, styles.center, { paddingHorizontal: 24 }]}>
        <Text style={{ fontSize: TYPE_SCALE.bodySmall, color: colors.text.secondary, marginBottom: 12, textAlign: 'center' }}>
          {userFacingError(keysQuery.error, t, 'openstoa.apiKeys.loadFailed')}
        </Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => void keysQuery.refetch()}>
          <Text style={styles.secondaryButtonText}>{t('openstoa.common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.apiKeys.title')}</Text>
        <Text style={styles.intro}>{t('openstoa.apiKeys.intro')}</Text>
      </View>

      {rawKey && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.status.success }]}>{t('openstoa.apiKeys.copyNowTitle')}</Text>
          <Text style={styles.intro}>{t('openstoa.apiKeys.hashOnlyStored')}</Text>
          <View style={styles.rawKeyBox}>
            <Text style={styles.rawKeyText} selectable>{rawKey}</Text>
          </View>
          <View style={styles.keyActions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={copyRawKey}>
              <Text style={styles.secondaryButtonText}>{t('openstoa.apiKeys.copy')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setRawKey(null)}>
              <Text style={styles.secondaryButtonText}>{t('openstoa.apiKeys.dismiss')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.apiKeys.createNewKey')}</Text>
        <TextInput
          style={styles.input}
          value={newName}
          onChangeText={setNewName}
          placeholder={t('openstoa.apiKeys.keyNamePlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          maxLength={MAX_NAME_LEN}
        />
        <Text style={[styles.keyMetaText, { marginTop: 6, marginBottom: 4 }]}>{t('openstoa.apiKeys.keyScope')}</Text>
        <CapabilityToggles allowedCmd={allowedCmd} selected={newCmd} onToggle={toggleNewCmd} styles={styles} colors={colors} />
        <Text style={[styles.keyMetaText, { marginTop: 12, marginBottom: 4 }]}>{t('openstoa.apiKeys.historyBackfill')}</Text>
        <HistoryScopeChips value={newHistory} onChange={setNewHistory} styles={styles} />
        <TouchableOpacity
          style={[styles.saveButton, { marginTop: 16 }, !canCreate && styles.saveButtonDisabled]}
          onPress={handleCreate}
          disabled={!canCreate}
        >
          {createMutation.isPending ? (
            <ActivityIndicator size="small" color={colors.text.inverted} />
          ) : (
            <Text style={styles.saveButtonText}>{t('openstoa.apiKeys.createKey')}</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.apiKeys.yourKeys')}</Text>
        {keys.length === 0 ? (
          <Text style={styles.intro}>{t('openstoa.apiKeys.noKeys')}</Text>
        ) : (
          keys.map((k) => {
            const revoked = !!k.revokedAt;
            const isEditing = editingId === k.id;
            return (
              <View key={k.id} style={[styles.keyRow, revoked && styles.keyRowRevoked]}>
                <View style={styles.keyRowHeader}>
                  <Text style={styles.keyName}>{k.name}</Text>
                  <Text style={styles.keyPrefix}>{k.prefix}…</Text>
                  {revoked && (
                    <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.status.danger, borderRadius: RADIUS.control, paddingHorizontal: 6 }}>
                      <Text style={{ fontSize: TYPE_SCALE.label, fontWeight: '600', color: colors.status.danger }}>{t('openstoa.apiKeys.revoked')}</Text>
                    </View>
                  )}
                </View>

                {isEditing ? (
                  <View style={{ marginTop: 10 }}>
                    <Text style={[styles.keyMetaText, { marginBottom: 4 }]}>{t('openstoa.apiKeys.keyScope')}</Text>
                    <CapabilityToggles allowedCmd={allowedCmd} selected={editCmd} onToggle={toggleEditCmd} styles={styles} colors={colors} />
                    <Text style={[styles.keyMetaText, { marginTop: 12, marginBottom: 4 }]}>{t('openstoa.apiKeys.historyBackfill')}</Text>
                    <HistoryScopeChips value={editHistory} onChange={setEditHistory} styles={styles} />
                    <View style={styles.keyActions}>
                      <TouchableOpacity
                        style={[styles.saveButton, { flex: 1 }, editMutation.isPending && styles.saveButtonDisabled]}
                        onPress={() => saveEdit(k.id)}
                        disabled={editMutation.isPending}
                      >
                        {editMutation.isPending ? (
                          <ActivityIndicator size="small" color={colors.text.inverted} />
                        ) : (
                          <Text style={styles.saveButtonText}>{t('openstoa.apiKeys.saveScope')}</Text>
                        )}
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.secondaryButton} onPress={cancelEdit} disabled={editMutation.isPending}>
                        <Text style={styles.secondaryButtonText}>{t('openstoa.common.cancel')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <>
                    <View style={styles.keyMetaRow}>
                      <Text style={styles.keyMetaText}>
                        {t('openstoa.apiKeys.scopeLabel', {
                          value: k.cmd.length === 0 ? t('openstoa.apiKeys.scopeNone') : k.cmd.map((c) => CMD_LABELS[c] ? t(CMD_LABELS[c]) : c).join(', '),
                        })}
                      </Text>
                      <Text style={styles.keyMetaText}>{t('openstoa.apiKeys.historyLabel', { value: scopeLabel(k.historyGrant, t) })}</Text>
                      <Text style={styles.keyMetaText}>{t('openstoa.apiKeys.createdLabel', { value: fmtDate(k.createdAt) })}</Text>
                      <Text style={styles.keyMetaText}>{t('openstoa.apiKeys.lastUsedLabel', { value: fmtDate(k.lastUsedAt) })}</Text>
                    </View>
                    {!revoked && (
                      <View style={styles.keyActions}>
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => startEdit(k)}>
                          <Text style={styles.secondaryButtonText}>{t('openstoa.apiKeys.editScope')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.dangerButton} onPress={() => confirmRevoke(k.id, k.name)}>
                          <Text style={styles.dangerButtonText}>{t('openstoa.apiKeys.revoke')}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                )}
              </View>
            );
          })
        )}
      </View>

      {Platform.OS === 'ios' ? <View style={{ height: 24 }} /> : null}
    </ScrollView>
  );
}
