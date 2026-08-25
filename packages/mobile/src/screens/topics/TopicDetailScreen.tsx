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
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import type { Topic, Post } from '@openstoa/api-types';
import { topicKeys } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { PostCard } from '../../components/PostCard';
import { QueryErrorState } from '../../components/QueryErrorState';
import { SortPills } from '../../components/SortPills';
import { SearchBar } from '../../components/SearchBar';
import { useAuthGuardedAction } from '../../auth';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';
import { archiveRetentionKey, isUnlimitedRetention } from '../../lib/archiveRetention';
import { getMlsSessionStore } from '../../crypto/mobileTransport';
import { InviteShareModal } from '../../components/InviteShareModal';

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

type SortKey = 'new' | 'popular' | 'recorded' | 'pinned';

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
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.status.danger,
    },
    topicHeader: {
      backgroundColor: colors.background.primary,
      padding: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.default,
    },
    // Title row holds the topic name + an inline JOINED badge so members can
    // tell at a glance which topics they belong to without opening the
    // settings sheet. Wraps onto a second line if the title is long.
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 6,
    },
    topicTitle: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
    },
    // Matches PostCard.joinedBadge — success-tint pill with uppercase mono
    // label so the badge reads the same wherever it appears.
    joinedBadge: {
      backgroundColor: colors.status.success + '22',
      borderRadius: RADIUS.control,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    joinedBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.status.success,
    },
    topicDescription: {
      fontSize: TYPE_SCALE.body,
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
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },
    retentionNote: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      lineHeight: 18,
      marginTop: 4,
    },
    badge: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginLeft: 4,
    },
    badgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brand.primary,
      borderRadius: RADIUS.card,
      paddingVertical: 12,
      minHeight: 44,
    },
    inviteOnlyNote: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
      textAlign: 'center',
      paddingVertical: 12,
    },
    actionButtonDisabled: {
      opacity: 0.6,
    },
    actionButtonText: {
      fontSize: TYPE_SCALE.body,
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
      borderRadius: RADIUS.pill,
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
      fontSize: TYPE_SCALE.caption,
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
      fontSize: TYPE_SCALE.bodySmall,
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

  const [inviteOpen, setInviteOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('new');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [q, setQ] = useState('');

  const topicQuery = useQuery<TopicDetailResponse>({
    queryKey: topicKeys.detail(topicId),
    queryFn: () => client.get<TopicDetailResponse>(`/api/topics/${topicId}`),
  });

  const postsQuery = useInfiniteQuery<PostsPageResponse, Error>({
    queryKey: topicKeys.posts(topicId, sortKey, activeTag, q),
    staleTime: 0, // always re-fetch on focus/navigation so new posts appear immediately
    queryFn: async ({ pageParam }) => {
      const offset = (pageParam as number | undefined) ?? 0;
      // The "pinned" chip is a pure client-side filter — the server has no
      // ?sort=pinned endpoint, so we request the default "new" ordering
      // and filter the response below to isPinned=true only.
      const serverSort =
        sortKey === 'popular' ? 'hot' : sortKey === 'pinned' ? 'new' : sortKey;
      const params = new URLSearchParams({
        limit: '20',
        offset: String(offset),
        sort: serverSort,
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
      queryClient.invalidateQueries({ queryKey: topicKeys.detail(topicId) });
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

  /**
   * Leave the topic.
   *
   * The MLS leaf is NOT evicted from here — the server holds no keys and cannot
   * commit (SI-1), so the next member to open the chat reconciles the tree
   * against the membership list and removes it. What this device can do is stop
   * holding the keys for a room it left, which `forgetTopic` does: nobody else
   * can reach in and delete them, and a live ratchet for a room you are no
   * longer in is exactly what a later compromise of this phone would open.
   */
  const leaveMutation = useMutation({
    mutationFn: async () => {
      await client.post(`/api/topics/${topicId}/leave`);
      try {
        await getMlsSessionStore(client, host.secureStore, host.localStore).forgetTopic(topicId);
      } catch {
        // The membership row is what gates access, and it is already gone.
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: topicKeys.detail(topicId) });
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      // Without this the topic keeps rendering a chat preview on the chat tab
      // for a room the user can no longer open.
      queryClient.invalidateQueries({ queryKey: ['my-topics'] });
      navigation.goBack();
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicDetail.leaveFailedTitle'), err.message);
    },
  });

  /** Ask before leaving — it costs this device its view of the history. */
  const confirmLeave = useCallback(() => {
    Alert.alert(
      t('openstoa.topicDetail.leaveConfirmTitle'),
      t('openstoa.topicDetail.leaveConfirmMessage'),
      [
        { text: t('openstoa.common.cancel'), style: 'cancel' },
        {
          text: t('openstoa.topicDetail.leave'),
          style: 'destructive',
          onPress: () => leaveMutation.mutate(),
        },
      ],
    );
  }, [leaveMutation, t]);

  const pinMutation = useMutation({
    mutationFn: async (postId: string) => {
      return client.post(`/api/posts/${postId}/pin`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: topicKeys.postsAll(topicId) });
    },
    onError: (err: Error) => {
      Alert.alert(t('openstoa.topicDetail.pinFailed'), err.message);
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
    const items: { label: string; action: () => void; destructive?: boolean }[] = [];
    items.push({
      label: t('openstoa.topicDetail.members'),
      action: () => navigation.navigate('TopicMembers', { topicId }),
    });
    if (isOwnerOrAdmin && !topic?.personal) {
      items.push({
        label: t('openstoa.topicDetail.requests'),
        action: () => navigation.navigate('TopicRequests', { topicId }),
      });
    }
    /*
     * Same rule, one case further: a personal space has no invite either.
     *
     * The route answers 403 to the owner as much as to anyone — that is the
     * whole feature — so drawing the button offers a share that cannot happen
     * and, worse, tells the owner their private space is shareable. `Requests`
     * above is skipped for the same reason: nothing can ever create one, so the
     * screen behind it is permanently empty.
     */
    if (!topic?.personal && (topic?.visibility === 'public' || isOwnerOrAdmin)) {
    items.push({
      label: t('openstoa.topicDetail.invite'),
      // Opens the share sheet through the dialog rather than straight away:
      // the invite-only tiers hand over chat history in the link's fragment,
      // and that choice is made before the link exists.
      action: () => setInviteOpen(true),
    });
    }
    if (isOwner) {
      items.push({
        label: t('openstoa.topicDetail.settings'),
        action: () => navigation.navigate('TopicEdit', { topicId }),
      });
    }
    // The owner gets no leave action: leaving would strand a topic nobody can
    // administer, and the route refuses it (409). An action that always fails
    // is worse than an absent one — mirrors the web topic header.
    if (!isOwner) {
      items.push({
        label: t('openstoa.topicDetail.leave'),
        action: confirmLeave,
        destructive: true,
      });
    }
    return items;
  }, [isMember, isOwner, isOwnerOrAdmin, navigation, t, topicId, confirmLeave, topic?.visibility, topic?.personal]);

  const showActionsSheet = useCallback(() => {
    if (headerActionItems.length === 0) return;
    const labels = [...headerActionItems.map((i) => i.label), t('openstoa.common.cancel')];
    const cancelButtonIndex = labels.length - 1;
    // Red on iOS for anything that takes something away. -1 means "none",
    // which is what ActionSheetIOS expects when nothing is destructive.
    const destructiveButtonIndex = headerActionItems.findIndex((i) => i.destructive);

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: t('openstoa.topicDetail.actions'),
          options: labels,
          cancelButtonIndex,
          destructiveButtonIndex,
        },
        (idx) => {
          if (idx >= 0 && idx < headerActionItems.length) {
            headerActionItems[idx].action();
          }
        },
      );
    } else {
      Alert.alert(t('openstoa.topicDetail.actions'), undefined, [
        ...headerActionItems.map((i) => ({
          text: i.label,
          onPress: i.action,
          style: i.destructive ? ('destructive' as const) : undefined,
        })),
        { text: t('openstoa.common.cancel'), style: 'cancel' as const },
      ]);
    }
  }, [headerActionItems, t]);

  // Declared BEFORE the header effect that lists it as a dependency. A `const`
  // is in its temporal dead zone until this line runs, and the effect's dep
  // array is built during render — so with the declaration further down, the
  // array read an uninitialised binding every render (TS2448/TS2454). Whether
  // that throws or merely reads `undefined` depends on how the bundler lowers
  // block scoping, and neither is something to leave to the bundler.
  const onRefresh = useCallback(() => {
    topicQuery.refetch();
    postsQuery.refetch();
  }, [topicQuery, postsQuery]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: topic?.title ?? t('openstoa.topics.detailTitle'),
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {/* Manual refresh button — re-fetches topic + posts */}
          <TouchableOpacity
            onPress={onRefresh}
            style={styles.headerButton}
            accessibilityLabel={t('openstoa.common.refresh', { defaultValue: 'Refresh' })}
          >
            <Feather name="refresh-cw" size={18} color={colors.text.secondary} />
          </TouchableOpacity>
          {headerActionItems.length > 0 && (
            <TouchableOpacity
              onPress={showActionsSheet}
              style={styles.headerButton}
              accessibilityLabel={t('openstoa.topicDetail.actions')}
            >
              <Feather name="more-horizontal" size={22} color={colors.brand.primary} />
            </TouchableOpacity>
          )}
        </View>
      ),
    });
  }, [navigation, topic, headerActionItems, showActionsSheet, onRefresh, t, colors, styles]);

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
  //
  // Client-side filter for the "Pinned" sort pill — server has no
  // ?sort=pinned endpoint, so we filter the default-sorted response to
  // isPinned=true only.
  let allPosts = dedupedPosts;
  if (sortKey === 'recorded') {
    allPosts = dedupedPosts.filter(
      (p) =>
        (p as Post & { recordCount?: number }).recordCount &&
        (p as Post & { recordCount?: number }).recordCount! > 0,
    );
  } else if (sortKey === 'pinned') {
    allPosts = dedupedPosts.filter(
      (p) => (p as Post & { isPinned?: boolean }).isPinned === true,
    );
  }

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

  /*
   * Before the `!topic` branch below, which cannot tell "this topic does not
   * exist" from "the request did not arrive" — and answering the second with
   * the first tells someone their topic is gone when their signal is.
   */
  if (topicQuery.isError) {
    return (
      <QueryErrorState
        title={t('openstoa.common.loadFailed.topic')}
        error={topicQuery.error}
        onRetry={() => void topicQuery.refetch()}
      />
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
    { key: 'pinned', label: t('openstoa.topicDetail.sort.pinned') },
  ];

  const ListHeader = (
    <View>
      <View style={styles.topicHeader}>
        <View style={styles.titleRow}>
          <Text style={styles.topicTitle}>{topic.title}</Text>
          {isMember ? (
            <View style={styles.joinedBadge}>
              <Text style={styles.joinedBadgeText}>
                {t('openstoa.topics.joinedBadge')}
              </Text>
            </View>
          ) : null}
        </View>
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
        {/* Members live with the window the admin chose at creation, so the room
            says what it is. Absent means unlimited — a topic that predates the
            setting deletes nothing. Members only: the chat it describes is
            members-only in every tier. */}
        {isMember ? (
          <View style={styles.topicMeta}>
            <Feather name="clock" size={14} color={colors.text.tertiary} />
            <Text style={styles.topicMetaText}>
              {t(
                `openstoa.topicDetail.archiveRetention.${archiveRetentionKey(
                  topic.chatArchiveRetentionDays ?? 0,
                )}`,
              )}
            </Text>
          </View>
        ) : null}
        {isMember ? (
          <Text style={styles.retentionNote}>
            {/*
              A personal space has its own sentence, because the usual one is a
              promise it cannot keep.
              
              Both standard notes are written around "a member who joins later"
              — that is what retention is FOR. Nobody joins this room later;
              every door answers 403. Telling the owner what a future member
              will be able to read describes a person who will never exist, and
              quietly suggests this space could be shared after all.
            */}
            {topic.personal
              ? t('openstoa.topicDetail.archiveRetention.notePersonal')
              : isUnlimitedRetention(topic.chatArchiveRetentionDays ?? 0)
                ? t('openstoa.topicDetail.archiveRetention.noteUnlimited')
                : t('openstoa.topicDetail.archiveRetention.noteWindowed')}
          </Text>
        ) : null}
        {isMember ? null : topic.visibility && topic.visibility !== 'public' ? (
          /*
           * No Join button on a topic that cannot be joined this way.
           *
           * `POST /join` answers 403 to everything that is not public — the
           * invite link is the only door, because for the scoped tiers that
           * link is also what carries the chat history keys. Offering the
           * button anyway gave the reported behaviour: press, a spinner, back
           * to "Join", and a 403 nobody sees. Saying what the topic IS costs
           * the same row and is true.
           */
          <Text style={styles.inviteOnlyNote} testID="topic-invite-only">
            {t('openstoa.topics.inviteOnly')}
          </Text>
        ) : (
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
      <InviteShareModal
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        topicId={topicId}
        visibility={topic.visibility}
      />
    </View>
  );
}
