import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { SearchBar } from '../../components/SearchBar';
import { initialFor } from '../../lib/peerProfile';
import { buildDmCandidatesPath, type DmCandidate } from '../../lib/dmCandidates';
import type { ChatStackParamList } from '../../navigation/stacks/ChatStack';

type Nav = NativeStackNavigationProp<ChatStackParamList, 'NewConversation'>;

const AVATAR_SIZE = 44;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background.primary },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    listContent: { paddingVertical: 4, flexGrow: 1 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border.default,
      marginLeft: 16 + AVATAR_SIZE + 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    rowDisabled: { opacity: 0.5 },
    avatar: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
      backgroundColor: colors.brand.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
      flexShrink: 0,
    },
    avatarText: { fontSize: 16, fontWeight: '700', color: colors.brand.primary },
    rowContent: { flex: 1 },
    peerName: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
    sharedTopic: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.text.primary },
    emptyBody: {
      fontSize: 13,
      color: colors.text.secondary,
      marginTop: 8,
      textAlign: 'center',
      lineHeight: 20,
    },
    errorTitle: { fontSize: 16, fontWeight: '600', color: colors.status.danger },
    errorBody: { fontSize: 12, color: colors.text.secondary, marginTop: 6, textAlign: 'center' },
    retryBtn: {
      marginTop: 16,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 18,
      backgroundColor: colors.brand.primary,
    },
    retryLabel: { color: '#FFFFFF', fontWeight: '600' },
  });
}

/**
 * "새 대화" (new conversation) picker — reached from the DM list header.
 * Backed by `GET /api/dm/candidates`, which already restricts the result to
 * people the caller shares at least one real topic with, de-duplicated so a
 * person sharing several topics appears exactly once (see
 * src/lib/dmCandidates.ts on the server). This screen does no client-side
 * filtering or de-duplication of its own — it renders exactly what the
 * server returns for the current search text.
 *
 * Search is submit-triggered via `SearchBar` (matches its documented
 * contract: "Backend search is keyword-triggered, not real-time"), so there
 * is no debounce logic to get wrong here.
 */
export function NewConversationScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<Nav>();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { isGuest } = useRequireAuth();

  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');

  const candidatesQuery = useQuery({
    queryKey: ['dm-candidates', q],
    queryFn: () => client.get<{ candidates: DmCandidate[] }>(buildDmCandidatesPath(q)),
    enabled: !isGuest,
  });

  // Same start-or-get pattern as TopicMembersScreen.openDm — POST /api/dm is
  // idempotent on the canonical dm_pair, so a double tap on the same row
  // still only opens one room; `isPending` additionally stops a *second*
  // in-flight request (and a second navigate) from a fast double tap.
  const startDmMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      client.post<{ topicId: string }>('/api/dm', { userId }),
  });

  const openDm = useCallback(
    (candidate: DmCandidate) => {
      if (startDmMutation.isPending) return;
      startDmMutation.mutate(
        { userId: candidate.userId },
        {
          onSuccess: (res) => {
            navigation.navigate('ChatRoom', { topicId: res.topicId, topicTitle: candidate.nickname, kind: 'dm' });
          },
        },
      );
    },
    [startDmMutation, navigation],
  );

  if (isGuest) return <GuestFallbackView />;

  const candidates = candidatesQuery.data?.candidates ?? [];

  return (
    <View style={styles.flex}>
      <SearchBar
        value={draft}
        onChangeText={setDraft}
        onSubmit={(value) => setQ(value)}
        onClear={() => setQ('')}
        placeholder={t('openstoa.dm.searchPlaceholder')}
      />

      {candidatesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand.primary} />
        </View>
      ) : candidatesQuery.error ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{t('openstoa.dm.candidatesError.title')}</Text>
          <Text style={styles.errorBody}>{(candidatesQuery.error as Error).message}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => candidatesQuery.refetch()}>
            <Text style={styles.retryLabel}>{t('openstoa.common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : candidates.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{t('openstoa.dm.candidatesEmpty.title')}</Text>
          <Text style={styles.emptyBody}>{t('openstoa.dm.candidatesEmpty.body')}</Text>
        </View>
      ) : (
        <FlatList
          data={candidates}
          keyExtractor={(c) => c.userId}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const [first, ...rest] = item.sharedTopics;
            const subtitle = first
              ? rest.length > 0
                ? `${t('openstoa.dm.sharedTopic', { title: first.title })} ${t('openstoa.dm.sharedTopicsMore', { count: rest.length })}`
                : t('openstoa.dm.sharedTopic', { title: first.title })
              : null;
            const disabled = startDmMutation.isPending;
            return (
              <TouchableOpacity
                style={[styles.row, disabled ? styles.rowDisabled : null]}
                activeOpacity={0.7}
                disabled={disabled}
                onPress={() => openDm(item)}
                accessibilityRole="button"
                accessibilityLabel={t('openstoa.peerProfile.message', { nickname: item.nickname })}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initialFor(item.nickname)}</Text>
                </View>
                <View style={styles.rowContent}>
                  <Text style={styles.peerName} numberOfLines={1}>
                    {item.nickname}
                  </Text>
                  {subtitle ? (
                    <Text style={styles.sharedTopic} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}
