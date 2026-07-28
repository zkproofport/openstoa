import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';

// Response of GET /api/profile/ai-permissions. `allowedCmd` is the server's
// full capability catalogue — the UI renders one toggle per entry so it never
// drifts from the server's ALLOWED_CMDS.
interface AiPermissions {
  cmd: string[];
  historyGrant: string;
  allowedCmd: string[];
}

// Human labels for the capability paths. Any cmd not listed falls back to its
// raw path, so a newly-added server capability still renders (just unlabelled).
const CMD_LABELS: Record<string, string> = {
  '/openstoa/topic/join': 'Join topics',
  '/openstoa/topic/leave': 'Leave / remove members',
  '/openstoa/post/read': 'Read posts',
  '/openstoa/post/write': 'Create & edit posts',
  '/openstoa/post/delete': 'Delete posts',
  '/openstoa/comment/read': 'Read comments',
  '/openstoa/comment/write': 'Write comments',
  '/openstoa/chat/read': 'Read chat & history',
  '/openstoa/chat/send': 'Send chat messages',
  '/openstoa/profile/read': 'Read profile',
  '/openstoa/profile/edit': 'Edit profile',
  '/ai/summarize': 'Summarize',
  '/ai/search': 'Search',
};

// History (chat archive) scope choices — a subset of the server's isValidTakScope
// grammar (none | Nd | since_epoch:N | full) that covers the common cases.
const HISTORY_SCOPES: { key: string; label: string }[] = [
  { key: 'none', label: 'No history' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'full', label: 'Full history' },
];

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background.secondary },
    scroll: { paddingVertical: 16 },
    section: {
      backgroundColor: colors.background.primary,
      marginHorizontal: 16,
      marginBottom: 16,
      borderRadius: 12,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.text.tertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    intro: { fontSize: 13, color: colors.text.secondary, lineHeight: 20, marginBottom: 4 },
    capRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    capLabel: { fontSize: 15, color: colors.text.primary, flex: 1, marginRight: 12 },
    capPath: { fontSize: 11, color: colors.text.tertiary },
    scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
    scopeChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    scopeChipActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
    scopeChipLabel: { fontSize: 13, color: colors.text.primary },
    scopeChipLabelActive: { color: colors.text.inverted, fontWeight: '600' },
    saveButton: {
      height: 48,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brand.primary,
    },
    saveButtonDisabled: { opacity: 0.5 },
    saveButtonText: { fontSize: 15, fontWeight: '700', color: colors.text.inverted },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  });
}

export function AiPermissionsScreen() {
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const permsQuery = useQuery<AiPermissions>({
    queryKey: ['profile', 'ai-permissions'],
    queryFn: () => client.get<AiPermissions>('/api/profile/ai-permissions'),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyGrant, setHistoryGrant] = useState('none');

  // Seed local state once the server config loads.
  useEffect(() => {
    if (permsQuery.data) {
      setSelected(new Set(permsQuery.data.cmd));
      setHistoryGrant(permsQuery.data.historyGrant || 'none');
    }
  }, [permsQuery.data]);

  const allowedCmd = useMemo(
    () => permsQuery.data?.allowedCmd ?? [],
    [permsQuery.data?.allowedCmd],
  );

  const toggleCmd = useCallback((cmd: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });
  }, []);

  const saveMutation = useMutation({
    mutationFn: (body: { cmd: string[]; historyGrant: string }) =>
      client.put<{ cmd: string[]; historyGrant: string }>('/api/profile/ai-permissions', body),
    onSuccess: (data) => {
      queryClient.setQueryData<AiPermissions | undefined>(['profile', 'ai-permissions'], (prev) =>
        prev ? { ...prev, cmd: data.cmd, historyGrant: data.historyGrant } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['profile', 'ai-permissions'] });
      Alert.alert('Saved', 'Your AI permissions have been updated.');
    },
    onError: (e) => {
      Alert.alert('Save failed', e instanceof Error ? e.message : String(e));
    },
  });

  const handleSave = useCallback(() => {
    // Preserve the server's ordering of allowedCmd for a stable payload.
    const cmd = allowedCmd.filter((c) => selected.has(c));
    saveMutation.mutate({ cmd, historyGrant });
  }, [allowedCmd, selected, historyGrant, saveMutation]);

  if (permsQuery.isLoading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="small" color={colors.brand.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AI permissions</Text>
        <Text style={styles.intro}>
          An AI agent logged in as you acts on your account. Choose exactly what your AI sessions may do
          across OpenStoa. These apply everywhere — not per topic. Your own actions are never restricted.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Capabilities</Text>
        {allowedCmd.map((cmd) => (
          <View key={cmd} style={styles.capRow}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={styles.capLabel}>{CMD_LABELS[cmd] ?? cmd}</Text>
              <Text style={styles.capPath}>{cmd}</Text>
            </View>
            <Switch
              value={selected.has(cmd)}
              onValueChange={() => toggleCmd(cmd)}
              trackColor={{ true: colors.brand.primary, false: colors.border.strong }}
            />
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Chat history the AI may back-fill</Text>
        <View style={styles.scopeRow}>
          {HISTORY_SCOPES.map((s) => {
            const active = historyGrant === s.key;
            return (
              <TouchableOpacity
                key={s.key}
                style={[styles.scopeChip, active && styles.scopeChipActive]}
                onPress={() => setHistoryGrant(s.key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.scopeChipLabel, active && styles.scopeChipLabelActive]}>{s.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.saveButton, saveMutation.isPending && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <ActivityIndicator size="small" color={colors.text.inverted} />
          ) : (
            <Text style={styles.saveButtonText}>Save AI permissions</Text>
          )}
        </TouchableOpacity>
      </View>

      {Platform.OS === 'ios' ? <View style={{ height: 24 }} /> : null}
    </ScrollView>
  );
}
