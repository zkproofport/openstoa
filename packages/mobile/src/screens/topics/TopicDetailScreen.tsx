import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  StyleSheet,
  RefreshControl,
  ActionSheetIOS,
  Platform,
  Pressable,
  Share,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import type { Topic, Post } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { PostCard } from '../../components/PostCard';
import { SortPills } from '../../components/SortPills';
import { SearchBar } from '../../components/SearchBar';
import { useAuthGuardedAction } from '../../auth';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Props = NativeStackScreenProps<TopicsStackParamList, 'TopicDetail'>;
type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicDetail'>;

// Matches openstoa/src/app/api/topics/[topicId]/route.ts:187-196 — `isMember`
// lives INSIDE `topic` (not at the top level), and `currentUserRole` is the
// only sibling. Reading the wrong path made the Join button show for the
// owner's own topic.
interface TopicDetailResponse {
  topic: Topic & { isMember?: boolean };
  currentUserRole?: 'owner' | 'admin' | 'member' | null;
}

interface PostsPageResponse {
  posts: Post[];
  nextCursor?: string | null;
}

interface InviteTokenResponse {
  token: string;
  expiresAt: string;
}

type SortKey = 'new' | 'popular' | 'recorded';

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    content: {
      paddingBottom: 24,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background.secondary,
    },
    errorText: {
      fontSize: 15,
      color: colors.status.danger,
    },
    topicHeader: {
      backgroundColor: colors.background.primary,
      padding: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.default,
    },
    topicTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text.primary,
      marginBottom: 6,
    },
    topicDescription: {
      fontSize: 14,
      color: colors.text.secondary,
      lineHeight: 20,
      marginBottom: 12,
    },
    topicMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 16,
    },
    topicMetaText: {
      fontSize: 13,
      color: colors.text.tertiary,
    },
    badge: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginLeft: 4,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brand.primary,
      borderRadius: 10,
      paddingVertical: 12,
      minHeight: 44,
    },
    actionButtonDisabled: {
      opacity: 0.6,
    },
    actionButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text.inverted,
    },
    // Floating "New Post" action button. Stays reachable while the user
    // scrolls through long post lists (the old inline button at the top
    // of the header was unreachable past the first viewport).
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 24,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
      // iOS shadow
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      // Android elevation
      elevation: 6,
    },
    fabContainer: {
      flex: 1,
    },
    sectionDivider: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 6,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.text.secondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    postsLoader: {
      marginVertical: 24,
    },
    emptyPosts: {
      alignItems: 'center',
      paddingVertical: 40,
    },
    emptyText: {
      fontSize: 14,
      color: colors.text.tertiary,
    },
    headerButton: {
      paddingHorizontal: 8,
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

export function TopicDetailScreen() {
  const { t } = useTranslation();
  const route = useRoute<Props['route']>();
  const navigation = useNavigation<Nav>();
  const { topicId } = route.params;
  const client = useOpenStoaClient();
  const host = useHost();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [sortKey, setSortKey] = useState<SortKey>('new');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [q, setQ] = useState('');

  const topicQuery = useQuery<TopicDetailResponse>({
    queryKey: ['topic', topicId],
    queryFn: () => client.get<TopicDetailResponse>(`/api/topics/${topicId}`),
  });

  const postsQuery = useInfiniteQuery<PostsPageResponse, Error>({
    queryKey: ['topic', topicId, 'posts', sortKey, activeTag, q],
    queryFn: async ({ pageParam }) => {
      const offset = (pageParam as number | undefined) ?? 0;
      const params = new URLSearchParams({
        limit: '20',
        offset: String(offset),
        sort: sortKey === 'popular' ? 'hot' : sortKey,
      });
      if (activeTag) params.set('tag', activeTag);
      if (q) params.set('q', q);
      const res = await client.get<{ posts: PostsPageResponse['posts'] }>(
        `/api/topics/${topicId}/posts?${params.toString()}`,
      );
      return {
        posts: res.posts,
        nextCursor: res.posts.length === 20 ? String(offset + 20) : undefined,
      };
    },
    initialPageParam: 0 as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.nextCursor ? Number(lastPage.nextCursor) : undefined,
  });

  const joinMutation = useMutation({
    mutationFn: async () => {
      const topic = topicQuery.data?.topic;
      const proofType = topic?.proofType;

      if (proofType && proofType !== 'none') {
        try {
          const circuitMap: Record<string, 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation'> = {
            kyc: 'coinbase_attestation',
            country: 'coinbase_country_attestation',
            google_workspace: 'oidc_domain_attestation',
            microsoft_365: 'oidc_domain_attestation',
            workspace: 'oidc_domain_attestation',
          };
          const circuit = circuitMap[proofType];
          if (circuit) {
            await host.generateProof({ scope: topicId, circuit });
          }
        } catch {
          Alert.alert(t('openstoa.topics.proofRequiredTitle'), t('openstoa.topics.proofRequiredMessage'));
          return;
        }
      }

      await client.post(`/api/topics/${topicId}/join`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId] });
      // Prefix-match every topics list query so the explore / browse
      // tab refreshes `isMember` for the joined topic. The previous
      // `['topics', 'joined']` key was dead code — TopicsHomeScreen uses
      // `['topics', 'all', sortKey, activeCategory, q]` and filters
      // joined client-side, so it never matched. `['topics']` prefix
      // catches every variant.
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      // ChatListScreen reads `['my-topics']` to know which topics to render
      // chat previews for; without this the newly-joined topic is missing
      // from the chat list until app restart.
      queryClient.invalidateQueries({ queryKey: ['my-topics'] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topics.joinFailedTitle'), err.message);
    },
  });

  const pinMutation = useMutation({
    mutationFn: async (postId: string) => {
      return client.post(`/api/posts/${postId}/pin`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topic', topicId, 'posts'] });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicDetail.pinFailed'), err.message);
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      return client.post<InviteTokenResponse>(`/api/topics/${topicId}/invite`);
    },
    onSuccess: async (res) => {
      try {
        await Share.share({
          message: t('openstoa.topics.invite.shareBody', { code: res.token }),
          title: t('openstoa.topics.invite.shareSubject'),
        });
      } catch {
        // user cancelled share — silent
      }
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topics.invite.joinFailedTitle'), err.message);
    },
  });

  // Guests tapping Join see the SignInSheet first; once signed in the
  // join (incl. proof generation) fires automatically via the gate's
  // replay path.
  const handleJoin = useAuthGuardedAction(() => joinMutation.mutate());

  const topic = topicQuery.data?.topic;
  const currentRole = topicQuery.data?.currentUserRole ?? null;
  // Owner/admin/member all imply membership. Falling back to `topic.isMember`
  // keeps backwards-compat with any older server build that doesn't set role.
  const isMember = currentRole !== null || (topic?.isMember ?? false);
  const isOwnerOrAdmin = currentRole === 'owner' || currentRole === 'admin';
  const isOwner = currentRole === 'owner';

  const headerActionItems = useMemo(() => {
    if (!isMember) return [];
    const items: { label: string; action: () => void }[] = [];
    items.push({
      label: t('openstoa.topicDetail.members'),
      action: () => navigation.navigate('TopicMembers', { topicId }),
    });
    if (isOwnerOrAdmin) {
      items.push({
        label: t('openstoa.topicDetail.requests'),
        action: () => navigation.navigate('TopicRequests', { topicId }),
      });
    }
    items.push({
      label: t('openstoa.topicDetail.invite'),
      action: () => inviteMutation.mutate(),
    });
    if (isOwner) {
      items.push({
        label: t('openstoa.topicDetail.settings'),
        action: () => navigation.navigate('TopicEdit', { topicId }),
      });
    }
    return items;
  }, [isMember, isOwner, isOwnerOrAdmin, navigation, t, topicId, inviteMutation]);

  const showActionsSheet = useCallback(() => {
    if (headerActionItems.length === 0) return;
    const labels = [...headerActionItems.map((i) => i.label), t('openstoa.common.cancel')];
    const cancelButtonIndex = labels.length - 1;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: t('openstoa.topicDetail.actions'),
          options: labels,
          cancelButtonIndex,
        },
        (idx) => {
          if (idx >= 0 && idx < headerActionItems.length) {
            headerActionItems[idx].action();
          }
        },
      );
    } else {
      Alert.alert(t('openstoa.topicDetail.actions'), undefined, [
        ...headerActionItems.map((i) => ({ text: i.label, onPress: i.action })),
        { text: t('openstoa.common.cancel'), style: 'cancel' as const },
      ]);
    }
  }, [headerActionItems, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: topic?.title ?? t('openstoa.topics.detailTitle'),
      headerRight: headerActionItems.length === 0
        ? undefined
        : () => (
            <TouchableOpacity
              onPress={showActionsSheet}
              style={styles.headerButton}
              accessibilityLabel={t('openstoa.topicDetail.actions')}
            >
              <Feather name="more-horizontal" size={22} color={colors.brand.primary} />
            </TouchableOpacity>
          ),
    });
  }, [navigation, topic, headerActionItems, showActionsSheet, t, colors, styles]);

  const rawPosts = postsQuery.data?.pages.flatMap((p) => p.posts) ?? [];
  // Defensive de-duplication to avoid "two children with the same key" warnings.
  const seenPostIds = new Set<string>();
  const dedupedPosts: typeof rawPosts = [];
  for (const p of rawPosts) {
    if (!seenPostIds.has(p.id)) {
      seenPostIds.add(p.id);
      dedupedPosts.push(p);
    }
  }
  // Client-side filter for the "Recorded" sort pill. The server's
  // `?sort=recorded` orders by recordCount DESC but still returns posts
  // with recordCount=0 once the recorded set is exhausted, so the user
  // sees a mostly-empty list mixed with un-recorded posts. Filtering on
  // the client guarantees the Recorded tab only shows posts that have
  // at least one on-chain record receipt — matching the user's mental
  // model of "Recorded = on-chain attested posts only".
  const allPosts = sortKey === 'recorded'
    ? dedupedPosts.filter((p) => (p as Post & { recordCount?: number }).recordCount && (p as Post & { recordCount?: number }).recordCount! > 0)
    : dedupedPosts;

  const onRefresh = useCallback(() => {
    topicQuery.refetch();
    postsQuery.refetch();
  }, [topicQuery, postsQuery]);

  const isRefreshing =
    (topicQuery.isFetching && !topicQuery.isLoading) ||
    (postsQuery.isFetching && !postsQuery.isLoading);

  const onPostLongPress = useCallback(
    (post: Post) => {
      if (!isOwnerOrAdmin) return;
      const isPinned = (post as Post & { isPinned?: boolean }).isPinned ?? false;
      const pinLabel = isPinned ? t('openstoa.topicDetail.unpin') : t('openstoa.topicDetail.pin');
      const labels = [pinLabel, t('openstoa.common.cancel')];

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: t('openstoa.topicDetail.postActions'),
            options: labels,
            cancelButtonIndex: labels.length - 1,
          },
          (idx) => {
            if (idx === 0) pinMutation.mutate(post.id);
          },
        );
      } else {
        Alert.alert(t('openstoa.topicDetail.postActions'), undefined, [
          { text: pinLabel, onPress: () => pinMutation.mutate(post.id) },
          { text: t('openstoa.common.cancel'), style: 'cancel' as const },
        ]);
      }
    },
    [isOwnerOrAdmin, pinMutation, t],
  );

  if (topicQuery.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  if (!topic) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{t('openstoa.topics.notFound')}</Text>
      </View>
    );
  }

  const sortItems: { key: SortKey; label: string }[] = [
    { key: 'new', label: t('openstoa.topicDetail.sort.new') },
    { key: 'popular', label: t('openstoa.topicDetail.sort.popular') },
    { key: 'recorded', label: t('openstoa.topicDetail.sort.recorded') },
  ];

  const ListHeader = (
    <View>
      <View style={styles.topicHeader}>
        <Text style={styles.topicTitle}>{topic.title}</Text>
        {topic.description ? (
          <Text style={styles.topicDescription}>{topic.description}</Text>
        ) : null}
        <View style={styles.topicMeta}>
          <Feather name="users" size={14} color={colors.text.tertiary} />
          <Text style={styles.topicMetaText}>{t('openstoa.topics.members', { count: topic.memberCount ?? 0 })}</Text>
          {topic.proofType && topic.proofType !== 'none' ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{topic.proofType}</Text>
            </View>
          ) : null}
        </View>
        {isMember ? null : (
          <TouchableOpacity
            style={[styles.actionButton, joinMutation.isPending && styles.actionButtonDisabled]}
            onPress={handleJoin}
            disabled={joinMutation.isPending}
          >
            {joinMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.text.inverted} />
            ) : (
              <>
                <Feather name="user-plus" size={16} color={colors.text.inverted} />
                <Text style={styles.actionButtonText}>{t('openstoa.topics.join')}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.sectionDivider}>
        <Text style={styles.sectionLabel}>{t('openstoa.topics.posts')}</Text>
      </View>
      <SortPills items={sortItems} value={sortKey} onChange={setSortKey} />
    </View>
  );

  return (
    <View style={styles.fabContainer}>
      <SearchBar
        value={searchDraft}
        onChangeText={setSearchDraft}
        onSubmit={(v) => setQ(v.trim())}
        onClear={() => { setSearchDraft(''); setQ(''); }}
        placeholder={t('openstoa.topicDetail.searchPlaceholder')}
      />
      <FlatList
        style={styles.list}
        data={allPosts}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={ListHeader}
        renderItem={({ item }) => (
          isOwnerOrAdmin ? (
            <Pressable onLongPress={() => onPostLongPress(item)} delayLongPress={400}>
              <PostCard
                post={item}
                onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
              />
            </Pressable>
          ) : (
            <PostCard
              post={item}
              onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
            />
          )
        )}
        ListEmptyComponent={
          postsQuery.isLoading ? (
            <ActivityIndicator style={styles.postsLoader} color={colors.brand.primary} />
          ) : (
            <View style={styles.emptyPosts}>
              <Text style={styles.emptyText}>{t('openstoa.feed.empty')}</Text>
            </View>
          )
        }
        onEndReached={() => {
          if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
            postsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          postsQuery.isFetchingNextPage ? (
            <ActivityIndicator style={styles.postsLoader} color={colors.brand.primary} />
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={colors.brand.primary}
          />
        }
        contentContainerStyle={styles.content}
      />
      {isMember ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('PostCreate', { topicId, topicTitle: topic.title })}
          activeOpacity={0.85}
          accessibilityLabel={t('openstoa.topics.newPost')}
        >
          <Feather name="edit-2" size={22} color={colors.text.inverted} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
