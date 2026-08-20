import React, { useCallback, useLayoutEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { QueryErrorState } from '../../components/QueryErrorState';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';
import { formatRelativeTime } from '../../utils/relativeTime';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';

type Props = NativeStackScreenProps<TopicsStackParamList, 'TopicRequests'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicRequests'>;

interface JoinRequestItem {
  id: string;
  userId: string;
  nickname: string;
  profileImage?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface RequestsResponse {
  requests: JoinRequestItem[];
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: {
      flex: 1,
      backgroundColor: colors.background.primary,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.primary,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
      gap: 12,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.tertiary,
    },
    rowText: {
      flex: 1,
    },
    nickname: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.primary,
    },
    timeText: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      marginTop: 2,
    },
    actions: {
      flexDirection: 'row',
      gap: 8,
    },
    actionBtn: {
      minHeight: TOUCH_TARGET_MIN,
      minWidth: 64,
      paddingHorizontal: 12,
      borderRadius: RADIUS.control,
      alignItems: 'center',
      justifyContent: 'center',
    },
    approveBtn: {
      backgroundColor: colors.brand.primary,
    },
    approveText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.inverted,
    },
    rejectBtn: {
      backgroundColor: colors.background.tertiary,
    },
    rejectText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    empty: {
      paddingVertical: 60,
      alignItems: 'center',
    },
    emptyContent: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    emptyText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
    },
    retiredNotice: {
      margin: 16,
      padding: 12,
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      color: colors.text.tertiary,
      backgroundColor: colors.background.secondary,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
    },
  });
}

export function TopicRequestsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Props['route']>();
  const { topicId } = route.params;
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  useLayoutEffect(() => {
    navigation.setOptions({ title: t('openstoa.requests.title') });
  }, [navigation, t]);

  const requestsQuery = useQuery<RequestsResponse>({
    queryKey: ['topic', topicId, 'requests'],
    queryFn: () => client.get<RequestsResponse>(`/api/topics/${topicId}/requests`),
  });

  const actionMutation = useMutation({
    mutationFn: async ({ requestId, action }: { requestId: string; action: 'approve' | 'reject' }) => {
      return client.patch(`/api/topics/${topicId}/requests`, { requestId, action });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'requests'] });
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'members'] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.requests.actionFailed'), err.message);
    },
  });

  const renderItem = useCallback(
    ({ item }: { item: JoinRequestItem }) => (
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Feather name="user" size={18} color={colors.text.tertiary} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.nickname} numberOfLines={1}>
            {item.nickname}
          </Text>
          <Text style={styles.timeText}>{formatRelativeTime(item.createdAt)}</Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.rejectBtn]}
            onPress={() => actionMutation.mutate({ requestId: item.id, action: 'reject' })}
            disabled={actionMutation.isPending}
            activeOpacity={0.7}
          >
            <Text style={styles.rejectText}>{t('openstoa.requests.reject')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.approveBtn]}
            onPress={() => actionMutation.mutate({ requestId: item.id, action: 'approve' })}
            disabled={actionMutation.isPending}
            activeOpacity={0.7}
          >
            <Text style={styles.approveText}>{t('openstoa.requests.approve')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [actionMutation, t, styles, colors],
  );

  if (requestsQuery.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  if (requestsQuery.isError) {
    // "No pending requests" is a decision an admin acts on. Saying it when the
    // list never loaded invites them to stop checking.
    return (
      <QueryErrorState
        title={t('openstoa.common.loadFailed.requests')}
        error={requestsQuery.error}
        onRetry={() => void requestsQuery.refetch()}
      />
    );
  }

  const requests = requestsQuery.data?.requests ?? [];

  return (
    <FlatList
      style={styles.list}
      data={requests}
      keyExtractor={(r) => r.id}
      renderItem={renderItem}
      /* Why this queue only ever shrinks. Topics became invite-only, so nothing
         adds to it — but the rows already here are still approvable, and an
         owner who is not told that would assume those people were dropped. */
      ListHeaderComponent={
        <Text style={styles.retiredNotice}>{t('openstoa.requests.retired')}</Text>
      }
      refreshControl={
        <RefreshControl
          refreshing={requestsQuery.isRefetching}
          onRefresh={() => requestsQuery.refetch()}
          tintColor={colors.brand.primary}
        />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t('openstoa.requests.empty')}</Text>
        </View>
      }
      contentContainerStyle={requests.length === 0 ? styles.emptyContent : undefined}
    />
  );
}
