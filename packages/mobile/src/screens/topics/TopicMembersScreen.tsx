import React, { useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  ActionSheetIOS,
  Alert,
  Platform,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Props = NativeStackScreenProps<TopicsStackParamList, 'TopicMembers'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicMembers'>;

type Role = 'owner' | 'admin' | 'member';

interface Member {
  userId: string;
  nickname: string;
  role: Role;
  profileImage?: string | null;
}

interface MembersResponse {
  members: Member[];
  currentUserRole?: Role;
}

interface TopicMetaResponse {
  currentUserRole?: Role | null;
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
      minHeight: 56,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
      gap: 12,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.tertiary,
    },
    rowText: {
      flex: 1,
    },
    nickname: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text.primary,
    },
    roleText: {
      fontSize: 12,
      color: colors.text.tertiary,
      marginTop: 2,
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
      fontSize: 14,
      color: colors.text.tertiary,
    },
  });
}

export function TopicMembersScreen() {
  const { t } = useTranslation();
  const route = useRoute<Props['route']>();
  const navigation = useNavigation<Nav>();
  const { topicId } = route.params;
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('openstoa.members.title') });
  }, [navigation, t]);

  const membersQuery = useQuery<MembersResponse>({
    queryKey: ['topic', topicId, 'members'],
    queryFn: () => client.get<MembersResponse>(`/api/topics/${topicId}/members`),
  });

  // Fall back to the topic detail endpoint to learn the current user's role
  // when the members listing doesn't include it.
  const topicMetaQuery = useQuery<TopicMetaResponse>({
    queryKey: ['topic', topicId],
    queryFn: () => client.get<TopicMetaResponse>(`/api/topics/${topicId}`),
  });

  const currentRole: Role | null =
    membersQuery.data?.currentUserRole ?? topicMetaQuery.data?.currentUserRole ?? null;
  const isOwner = currentRole === 'owner';

  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) => {
      return client.patch(`/api/topics/${topicId}/members`, { userId, role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'members'] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.members.actionFailed'), err.message);
    },
  });

  const kickMutation = useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      return client.request(`/api/topics/${topicId}/members`, {
        method: 'DELETE',
        body: JSON.stringify({ userId }),
        headers: { 'Content-Type': 'application/json' },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'members'] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.members.actionFailed'), err.message);
    },
  });

  const transferMutation = useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      return client.patch(`/api/topics/${topicId}/members`, { userId, role: 'owner' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'members'] });
      queryClient.invalidateQueries({ queryKey: ['topic', topicId] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.members.actionFailed'), err.message);
    },
  });

  const isOwnerOrAdmin = currentRole === 'owner' || currentRole === 'admin';

  const onMemberLongPress = useCallback(
    (member: Member) => {
      if (!isOwnerOrAdmin || member.role === 'owner') return;

      const options: { label: string; action: () => void; destructive?: boolean }[] = [];

      // Owner-only actions
      if (isOwner) {
        if (member.role === 'member') {
          options.push({
            label: t('openstoa.members.promote'),
            action: () => roleMutation.mutate({ userId: member.userId, role: 'admin' }),
          });
        } else if (member.role === 'admin') {
          options.push({
            label: t('openstoa.members.demote'),
            action: () => roleMutation.mutate({ userId: member.userId, role: 'member' }),
          });
        }
        options.push({
          label: t('openstoa.members.transfer'),
          action: () => {
            Alert.alert(
              t('openstoa.members.transfer'),
              t('openstoa.members.transferConfirm', { nickname: member.nickname }),
              [
                { text: t('openstoa.common.cancel'), style: 'cancel' },
                {
                  text: t('openstoa.members.transfer'),
                  style: 'destructive',
                  onPress: () => transferMutation.mutate({ userId: member.userId }),
                },
              ],
            );
          },
        });
      }

      // Kick: owner can kick anyone non-owner; admin can kick regular members
      const canKick = isOwner || (currentRole === 'admin' && member.role === 'member');
      if (canKick) {
        options.push({
          label: t('openstoa.members.kick'),
          destructive: true,
          action: () => {
            Alert.alert(
              t('openstoa.members.kick'),
              t('openstoa.members.kickConfirm'),
              [
                { text: t('openstoa.common.cancel'), style: 'cancel' },
                {
                  text: t('openstoa.members.kick'),
                  style: 'destructive',
                  onPress: () => kickMutation.mutate({ userId: member.userId }),
                },
              ],
            );
          },
        });
      }

      if (options.length === 0) return;

      const labels = [...options.map((o) => o.label), t('openstoa.common.cancel')];
      const cancelButtonIndex = labels.length - 1;
      const destructiveButtonIndex = options.findIndex((o) => o.destructive);

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: t('openstoa.members.actionsForMember', { nickname: member.nickname }),
            options: labels,
            cancelButtonIndex,
            destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
          },
          (idx: number) => {
            if (idx >= 0 && idx < options.length) options[idx].action();
          },
        );
      } else {
        Alert.alert(
          t('openstoa.members.actionsForMember', { nickname: member.nickname }),
          undefined,
          [
            ...options.map((o) => ({
              text: o.label,
              style: o.destructive ? ('destructive' as const) : ('default' as const),
              onPress: o.action,
            })),
            { text: t('openstoa.common.cancel'), style: 'cancel' as const },
          ],
        );
      }
    },
    [isOwner, isOwnerOrAdmin, currentRole, kickMutation, roleMutation, transferMutation, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: Member }) => {
      const roleLabel =
        item.role === 'owner'
          ? t('openstoa.members.role.owner')
          : item.role === 'admin'
          ? t('openstoa.members.role.admin')
          : t('openstoa.members.role.member');
      const canActOn = item.role !== 'owner' && (
        isOwner || (currentRole === 'admin' && item.role === 'member')
      );
      const isPressable = canActOn;
      const Container = isPressable ? TouchableOpacity : View;

      return (
        <Container
          style={styles.row}
          onLongPress={isPressable ? () => onMemberLongPress(item) : undefined}
          activeOpacity={isPressable ? 0.7 : 1}
        >
          <View style={styles.avatar}>
            <Feather name="user" size={18} color={colors.text.tertiary} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.nickname} numberOfLines={1}>
              {item.nickname}
            </Text>
            <Text style={styles.roleText}>{roleLabel}</Text>
          </View>
          {isPressable ? (
            <Feather name="more-vertical" size={18} color={colors.text.tertiary} />
          ) : null}
        </Container>
      );
    },
    [isOwner, onMemberLongPress, t, styles, colors],
  );

  if (membersQuery.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  const members = membersQuery.data?.members ?? [];

  return (
    <FlatList
      style={styles.list}
      data={members}
      keyExtractor={(m) => m.userId}
      renderItem={renderItem}
      refreshControl={
        <RefreshControl
          refreshing={membersQuery.isRefetching}
          onRefresh={() => membersQuery.refetch()}
          tintColor={colors.brand.primary}
        />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t('openstoa.members.empty')}</Text>
        </View>
      }
      contentContainerStyle={members.length === 0 ? styles.emptyContent : undefined}
    />
  );
}
