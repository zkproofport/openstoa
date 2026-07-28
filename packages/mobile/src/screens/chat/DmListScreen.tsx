import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';

// A DM channel as returned by GET /api/dm. SI-1: routing metadata only —
// the server never exposes message content here (bodies are E2EE ciphertext,
// decrypted only inside ChatRoom via the MLS session).
interface DmChannel {
  topicId: string;
  peer: { userId: string; nickname: string; profileImage: string | null };
  lastActivityAt: string | null;
}

const AVATAR_SIZE = 44;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: colors.background.primary,
    },
    listContent: { paddingVertical: 4 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border.default,
      marginLeft: 16 + AVATAR_SIZE + 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: colors.background.primary,
    },
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
    avatarText: { fontSize: 18, fontWeight: '700', color: colors.brand.primary },
    rowContent: { flex: 1 },
    peerName: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
    time: { fontSize: 11, color: colors.text.tertiary, marginLeft: 8, flexShrink: 0 },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.text.primary },
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

export function DmListScreen() {
  const client = useOpenStoaClient();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const { isGuest } = useRequireAuth();

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['dm-list'],
    queryFn: () => client.get<{ dms: DmChannel[] }>('/api/dm'),
    enabled: !isGuest,
  });

  const dms: DmChannel[] = data?.dms ?? [];

  // Refresh the DM list whenever it regains focus so a DM just started from a
  // member's profile shows up immediately on return.
  useFocusEffect(
    useCallback(() => {
      if (isGuest) return;
      queryClient.invalidateQueries({ queryKey: ['dm-list'] });
    }, [queryClient, isGuest]),
  );

  if (isGuest) return <GuestFallbackView />;

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.brand.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn’t load messages</Text>
        <Text style={styles.errorBody}>{(error as Error).message}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (dms.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No direct messages</Text>
        <Text style={styles.emptyBody}>
          Open a member’s profile and tap Message to start a 1:1 conversation.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={dms}
      keyExtractor={(d) => d.topicId}
      refreshing={isRefetching}
      onRefresh={() => refetch()}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          onPress={() =>
            navigation.navigate('ChatRoom', {
              topicId: item.topicId,
              topicTitle: item.peer.nickname,
            })
          }
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{item.peer.nickname.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.rowContent}>
            <Text style={styles.peerName} numberOfLines={1}>
              {item.peer.nickname}
            </Text>
          </View>
          {item.lastActivityAt ? (
            <Text style={styles.time}>{formatRelativeTime(item.lastActivityAt)}</Text>
          ) : null}
        </TouchableOpacity>
      )}
      contentContainerStyle={styles.listContent}
    />
  );
}
