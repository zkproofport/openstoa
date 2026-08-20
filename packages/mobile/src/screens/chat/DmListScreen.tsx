import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { QueryErrorState } from '../../components/QueryErrorState';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { ChatStackParamList } from '../../navigation/stacks/ChatStack';
import { formatRelativeTime } from '../../utils/relativeTime';
import { initialFor } from '../../lib/peerProfile';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';

type Nav = NativeStackNavigationProp<ChatStackParamList, 'DmList'>;

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
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
      flexShrink: 0,
    },
    avatarText: { fontSize: TYPE_SCALE.bodyLarge, fontWeight: '700', color: colors.brand.primary },
    rowContent: { flex: 1 },
    peerName: { fontSize: TYPE_SCALE.body, fontWeight: '600', color: colors.text.primary },
    time: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary, marginLeft: 8, flexShrink: 0 },
    emptyTitle: { fontSize: TYPE_SCALE.bodyLarge, fontWeight: '600', color: colors.text.primary },
    emptyBody: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      marginTop: 8,
      textAlign: 'center',
      lineHeight: 20,
    },
    newConversationBtn: {
      marginTop: 20,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
    },
    newConversationLabel: { color: '#FFFFFF', fontWeight: '600', fontSize: TYPE_SCALE.bodySmall },
  });
}

export function DmListScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<Nav>();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const { isGuest } = useRequireAuth();

  // Entry point 2/2 for starting a DM (entry point 1 is a member's profile
  // card / TopicMembersScreen's message icon). Kept as a header button so
  // it's reachable even when the list is non-empty.
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('NewConversation')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t('openstoa.dm.newConversation')}
        >
          <Feather name="edit" size={20} color={colors.text.primary} />
        </Pressable>
      ),
    });
  }, [navigation, t, colors]);

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
      <QueryErrorState
        title={t('openstoa.dm.error.title')}
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  if (dms.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t('openstoa.dm.empty.title')}</Text>
        <Text style={styles.emptyBody}>{t('openstoa.dm.empty.body')}</Text>
        <TouchableOpacity
          style={styles.newConversationBtn}
          onPress={() => navigation.navigate('NewConversation')}
          accessibilityRole="button"
        >
          <Text style={styles.newConversationLabel}>{t('openstoa.dm.newConversation')}</Text>
        </TouchableOpacity>
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
              kind: 'dm',
            })
          }
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialFor(item.peer.nickname)}</Text>
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
