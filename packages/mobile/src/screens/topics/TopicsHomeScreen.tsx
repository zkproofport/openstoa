import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { listKeys } from '@openstoa/api-types';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import type { Topic } from '@openstoa/api-types';
import { OpenStoaApiError } from '../../api/openstoaClient';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { getTakSessionStore } from '../../crypto/mobileTransport';
import { parseInviteLink, readInviteHistory } from '../../lib/inviteLink';
import { useAuthGuardedAction } from '../../auth';
import { TopicCard } from '../../components/TopicCard';
import { SortPills } from '../../components/SortPills';
import { TagChips } from '../../components/TagChips';
import { SearchBar } from '../../components/SearchBar';
import { QueryErrorState } from '../../components/QueryErrorState';
import { InvitePromptModal } from '../../components/InvitePromptModal';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';

type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicsHome'>;

interface TopicsListResponse {
  topics: Topic[];
  /**
   * The caller's own space, sent alongside the list rather than inside it.
   *
   * `topics` promises that every row in it matched the query — the search and
   * the category filter — and the space matches neither, so including it there
   * would make a filtered list return a row with no category. Null for a guest,
   * and for any account whose space has not been made yet.
   */
  pinned?: Topic | null;
}

interface CategoryItem {
  id: string;
  name: string;
  slug: string;
}

interface CategoriesResponse {
  categories: CategoryItem[];
}

type SortKey = 'hot' | 'new' | 'active' | 'top';

interface InviteJoinResponse {
  success: boolean;
  topicId: string;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    // Same height and padding as TagChips' folded header, so a failed load
    // occupies the row it replaces instead of shifting the list under it.
    categoryFailed: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      minHeight: 44,
      backgroundColor: colors.background.primary,
    },
    categoryFailedText: {
      flex: 1,
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    categoryRetry: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    list: {
      flex: 1,
    },
    content: {
      paddingBottom: 24,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 60,
    },
    emptyText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
    },
    sectionHeader: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 6,
    },
    sectionTitle: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
      color: colors.text.secondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    headerActions: {
      flexDirection: 'row',
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

export function TopicsHomeScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const client = useOpenStoaClient();
  const host = useHost();
  // Auth-guarded header actions — opens the SignInSheet for guests, then
  // navigates / opens the modal automatically after sign-in.
  const openInvitePrompt = useAuthGuardedAction(() => setInviteOpen(true));
  const openCreateTopic = useAuthGuardedAction(() =>
    navigation.navigate('TopicCreate'),
  );
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [sortKey, setSortKey] = useState<SortKey>('hot');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membershipFilter, setMembershipFilter] = useState<'all' | 'joined'>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [q, setQ] = useState('');

  // Single unified query: server returns every visible topic with an
  // `isMember` flag. Filtering by "joined" happens client-side (instant,
  // no extra request needed since server attaches `isMember` per topic).
  // Keyword search (?q=) goes to the server so full-text matching covers
  // all topics, not just the ones already loaded.
  const topicsQuery = useQuery<Topic[]>({
    queryKey: ['topics', 'all', sortKey, activeCategory, q],
    queryFn: async () => {
      const params = new URLSearchParams({ view: 'all', sort: sortKey });
      if (activeCategory) params.set('category', activeCategory);
      if (q) params.set('q', q);
      const res = await client.get<TopicsListResponse>(`/api/topics?${params.toString()}`);
      /*
       * The caller's own space arrives BESIDE the list, and belongs on top of it.
       *
       * The server keeps it out of `topics` on purpose: that array promises
       * every row in it matched the search and the category filter, and the
       * space matches neither — it has no category and is not a search result.
       * Putting it back here is what makes "always in the topic list" true
       * without making that promise false.
       *
       * Dropped in when a row for it is somehow already present, so a future
       * server that does include it cannot produce two.
       */
      const rows = res.topics ?? [];
      if (!res.pinned) return rows;
      return [res.pinned, ...rows.filter((t) => t.id !== res.pinned!.id)];
    },
  });

  const categoriesQuery = useQuery<CategoriesResponse>({
    queryKey: listKeys.categories(),
    queryFn: () => client.get<CategoriesResponse>('/api/categories'),
    staleTime: 5 * 60_000,
  });

  /**
   * Join by whatever was pasted — a bare code or a whole invite link.
   *
   * The link matters because of what is attached to it: for a private or
   * secret topic the chat-history keys ride in the FRAGMENT, which never
   * reaches the server. Posting only the code would join the topic and throw
   * the keys away silently, so the fragment is kept here and imported once
   * membership is real. Nothing about the fragment is sent or logged.
   */
  const inviteJoinMutation = useMutation({
    mutationFn: async (pasted: string) => {
      const invite = parseInviteLink(pasted);
      if (!invite) throw new Error(t('openstoa.topics.invite.invalidCode'));
      const res = await client.post<InviteJoinResponse>(
        `/api/topics/join/${encodeURIComponent(invite.code)}`,
      );
      // Only after the join. A link whose token expired can still carry a
      // perfectly good fragment, and importing from it would put keys for a
      // topic this device is not in — and cannot leave — into its keychain.
      const read = readInviteHistory(invite.fragment, res.topicId);
      let history: 'none' | 'wrong-topic' | 'already' | number = 'none';
      if (read.status === 'wrong-topic') {
        history = 'wrong-topic';
      } else if (read.status === 'ok') {
        const added = await getTakSessionStore(client, host.secureStore, host.localStore)
          .importInviteHistory(res.topicId, read.taks)
          .catch(() => 0);
        // Zero is what re-opening the same link looks like, not a failure.
        history = added > 0 ? added : 'already';
      }
      return { ...res, history };
    },
    onSuccess: (res) => {
      setInviteOpen(false);
      if (typeof res.history === 'number') {
        Alert.alert(
          t('openstoa.topics.invite.joinedTitle'),
          t('openstoa.topics.invite.historyImported', { count: res.history }),
        );
      } else if (res.history === 'wrong-topic') {
        Alert.alert(
          t('openstoa.topics.invite.joinedTitle'),
          t('openstoa.topics.invite.historyWrongTopic'),
        );
      }
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      // ChatListScreen reads `['my-topics']` to know which topics to render
      // chat previews for; without this the newly-joined topic is missing
      // from the chat list until app restart.
      queryClient.invalidateQueries({ queryKey: ['my-topics'] });
      navigation.navigate('TopicDetail', { topicId: res.topicId });
    },
    onError: (err: Error) => {
      // Read the STATUS, not the message text. This used to search the message
      // for "409" and "404", which only worked because the message was the raw
      // request line — the same string that was putting `/api/...` on screen
      // whenever neither substring matched. `err.message` is now the sentence
      // to show, so the status has to come from the typed error.
      const status = err instanceof OpenStoaApiError ? err.status : null;
      const msg =
        status === 409
          ? t('openstoa.topics.invite.alreadyMember')
          : status === 404
          ? t('openstoa.topics.invite.invalidCode')
          : err.message;
      Alert.alert(t('openstoa.topics.invite.joinFailedTitle'), msg);
    },
  });

  const isRefreshing = topicsQuery.isFetching && !topicsQuery.isLoading;

  const onRefresh = useCallback(() => {
    topicsQuery.refetch();
  }, [topicsQuery]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={openInvitePrompt}
            style={styles.headerButton}
            accessibilityLabel={t('openstoa.topics.invite.cta')}
          >
            <Feather name="link" size={20} color={colors.brand.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={openCreateTopic}
            style={styles.headerButton}
          >
            <Feather name="plus" size={22} color={colors.brand.primary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, t, colors, styles, openInvitePrompt, openCreateTopic]);

  const sortItems: { key: SortKey; label: string }[] = useMemo(
    () => [
      { key: 'hot', label: t('openstoa.topics.sort.hot') },
      { key: 'new', label: t('openstoa.topics.sort.new') },
      { key: 'active', label: t('openstoa.topics.sort.active') },
      { key: 'top', label: t('openstoa.topics.sort.top') },
    ],
    [t],
  );

  const categoryChips = useMemo(() => {
    const all = { slug: null, label: t('openstoa.topics.category.all') };
    const cats = (categoriesQuery.data?.categories ?? []).map((c) => ({
      slug: c.slug,
      label: c.name,
    }));
    return [all, ...cats];
  }, [categoriesQuery.data, t]);

  const isLoading = topicsQuery.isLoading;

  const allTopics = topicsQuery.data ?? [];

  // Apply membership filter client-side. The server already attaches
  // `isMember` per topic so no extra request is needed for this toggle.
  // Keyword search is handled server-side via ?q= in the query above.
  const visibleTopics = useMemo(() => {
    return allTopics.filter((tt) => {
      if (membershipFilter === 'joined' && !tt.isMember) return false;
      return true;
    });
  }, [allTopics, membershipFilter]);

  /*
   * Which topics, on the same line as in what order.
   *
   * These were two stacked rows of pills. They are two questions, but small
   * ones — six words between them — and on a phone they were pushing the list
   * itself below the fold before a single topic had been read. One row, with a
   * rule between the groups so they still read as two questions.
   */
  const membershipItems = useMemo(
    () => [
      { key: 'all' as const, label: t('openstoa.topics.filter.all', { defaultValue: 'All' }) },
      { key: 'joined' as const, label: t('openstoa.topics.filter.joined', { defaultValue: 'Joined' }) },
    ],
    [t],
  );

  const Header = (
    <View>
      <SortPills
        items={sortItems}
        value={sortKey}
        onChange={setSortKey}
        leading={{
          items: membershipItems,
          value: membershipFilter,
          onChange: setMembershipFilter,
          accessibilityLabel: t('openstoa.topics.filter.groupLabel', {
            defaultValue: 'Which topics',
          }),
        }}
      />
      {categoriesQuery.isError ? (
        /*
         * A failed category load USED to remove the row entirely, because the
         * row renders on `chips.length > 1` and a failure leaves only "All".
         * From the outside that is indistinguishable from the feature being
         * gone — which is exactly how it was reported. Say it instead, and
         * offer the one thing that fixes it.
         */
        <TouchableOpacity
          onPress={() => categoriesQuery.refetch()}
          activeOpacity={0.7}
          accessibilityRole="button"
          testID="category-load-failed"
          style={styles.categoryFailed}
        >
          <Text style={styles.categoryFailedText} numberOfLines={1}>
            {t('openstoa.topics.category.loadFailed')}
          </Text>
          <Text style={styles.categoryRetry}>{t('openstoa.common.retry')}</Text>
        </TouchableOpacity>
      ) : categoryChips.length > 1 ? (
        // Folded by default. It is the longest row, the least often changed,
        // and the header keeps saying which category is in force.
        <TagChips
          chips={categoryChips}
          value={activeCategory}
          onChange={setActiveCategory}
          collapsible
          title={t('openstoa.topics.category.label', { defaultValue: 'Category' })}
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <SearchBar
        value={searchDraft}
        onChangeText={setSearchDraft}
        onSubmit={(v) => setQ(v.trim())}
        onClear={() => { setSearchDraft(''); setQ(''); }}
        placeholder={t('openstoa.topics.searchPlaceholder', { defaultValue: 'Search topics' })}
      />
      {isLoading ? (
        <View style={styles.list}>
          {Header}
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand.primary} />
          </View>
        </View>
      ) : topicsQuery.isError ? (
        /*
         * Checked BEFORE the list, because the list's own empty state is the
         * lie this fixes: a failed fetch left `data` undefined, the FlatList
         * rendered `ListEmptyComponent`, and the screen said "No topics found"
         * while the phone was in aeroplane mode. The header stays so the
         * filters are still there to see, and the retry is the only new thing
         * asked of anyone.
         */
        <View style={styles.list}>
          {Header}
          <QueryErrorState
            title={t('openstoa.common.loadFailed.topics')}
            error={topicsQuery.error}
            onRetry={() => void topicsQuery.refetch()}
          />
        </View>
      ) : (
        <FlatList<Topic>
          style={styles.list}
          data={visibleTopics}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={Header}
          renderItem={({ item }) => (
            <TopicCard
              topic={item}
              onPress={() => navigation.navigate('TopicDetail', { topicId: item.id })}
              isJoined={!!item.isMember}
              onJoin={
                item.isMember
                  ? undefined
                  : () => navigation.navigate('TopicDetail', { topicId: item.id })
              }
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                {q
                  ? t('openstoa.topics.searchEmpty', { defaultValue: 'No topics match your search' })
                  : membershipFilter === 'joined'
                  ? t('openstoa.topics.joinedEmpty', { defaultValue: "You haven't joined any topics yet" })
                  : t('openstoa.topics.notFound')}
              </Text>
            </View>
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
      )}
      <InvitePromptModal
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSubmit={async (pasted) => {
          // Swallowed here because the mutation's onError already surfaces it;
          // the modal only needs to know when the attempt is over.
          await inviteJoinMutation.mutateAsync(pasted).catch(() => undefined);
        }}
        submitting={inviteJoinMutation.isPending}
      />
    </View>
  );
}
