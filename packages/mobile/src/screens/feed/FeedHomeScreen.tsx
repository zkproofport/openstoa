import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { Post } from '@openstoa/api-types';
import type { FeedStackParamList } from '../../navigation/stacks/FeedStack';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { PostCard } from '../../components/PostCard';
import { SortPills } from '../../components/SortPills';
import { TagChips } from '../../components/TagChips';
import { SearchBar } from '../../components/SearchBar';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { useAuthGuardedAction } from '../../auth';
import { RecordIcon } from '../../components/icons';

interface FeedPage {
  posts: Post[];
  nextCursor?: string;
}

type FeedNavProp = NativeStackNavigationProp<FeedStackParamList, 'FeedHome'>;

type SortKey = 'hot' | 'new' | 'active' | 'top';

interface TagItem {
  id: string;
  name: string;
  slug: string;
  postCount?: number;
}

interface TagsResponse {
  tags: TagItem[];
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    list: {
      flexGrow: 1,
    },
    emptyContent: {
      flexGrow: 1,
    },
    centeredContent: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    errorText: {
      fontSize: 15,
      color: colors.status.danger,
      marginBottom: 12,
      textAlign: 'center',
    },
    retryText: {
      fontSize: 14,
      color: colors.brand.primary,
      fontWeight: '600',
    },
    emptyWrap: {
      paddingVertical: 80,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 15,
      color: colors.text.tertiary,
      textAlign: 'center',
    },
    footerSpinner: {
      paddingVertical: 16,
    },
    // "Recorded on Base" entry pill — sits above the sort pills as a
    // shortcut into the cross-topic on-chain recorded feed. Purple tint
    // matches the RecordIcon's accent so it reads as a related affordance.
    recordedChipWrap: {
      paddingHorizontal: 16,
      paddingTop: 10,
      backgroundColor: colors.background.primary,
    },
    recordedChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: 'rgba(139,92,246,0.10)',
      borderWidth: 1,
      borderColor: 'rgba(139,92,246,0.25)',
    },
    recordedChipText: {
      fontSize: 12,
      fontWeight: '600',
      color: '#a78bfa',
    },
  });
}

export function FeedHomeScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<FeedNavProp>();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [sortKey, setSortKey] = useState<SortKey>('hot');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [q, setQ] = useState('');

  const tagsQuery = useQuery<TagsResponse>({
    queryKey: ['feed', 'tags'],
    queryFn: () => client.get<TagsResponse>('/api/tags'),
    staleTime: 60_000,
  });

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useInfiniteQuery<FeedPage>({
    queryKey: ['feed', sortKey, activeTag, q],
    queryFn: async ({ pageParam }) => {
      const offset = (pageParam as number | undefined) ?? 0;
      const params = new URLSearchParams({
        limit: '20',
        offset: String(offset),
        sort: sortKey,
      });
      if (activeTag) params.set('tag', activeTag);
      if (q) params.set('q', q);
      const res = await client.get<{ posts: Post[] }>(`/api/feed?${params.toString()}`);
      return { posts: res.posts, nextCursor: res.posts.length === 20 ? String(offset + 20) : undefined };
    },
    initialPageParam: 0 as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.nextCursor ? Number(lastPage.nextCursor) : undefined),
  });

  // Defensive de-duplication: if the backend returns the same post.id in
  // overlapping pages (cursor edge cases), React's "two children with the
  // same key" warning fires. Drop duplicates while preserving order.
  const rawPosts: Post[] = data?.pages.flatMap((p) => p.posts) ?? [];
  const seenIds = new Set<string>();
  const posts: Post[] = [];
  for (const p of rawPosts) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      posts.push(p);
    }
  }

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handlePressPost = useCallback(
    (postId: string) => {
      navigation.navigate('PostDetail', { postId });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Post }) => (
      <PostCard post={item} onPress={() => handlePressPost(item.id)} />
    ),
    [handlePressPost],
  );

  const keyExtractor = useCallback((item: Post) => item.id, []);

  const sortItems: { key: SortKey; label: string }[] = [
    { key: 'hot', label: t('openstoa.feed.sort.hot') },
    { key: 'new', label: t('openstoa.feed.sort.new') },
    { key: 'active', label: t('openstoa.feed.sort.active') },
    { key: 'top', label: t('openstoa.feed.sort.top') },
  ];

  const topTags = (tagsQuery.data?.tags ?? []).slice(0, 10);
  const tagChips = topTags.length > 0
    ? [
        { slug: null, label: t('openstoa.feed.tagAll') },
        ...topTags.map((tag) => ({ slug: tag.slug, label: `#${tag.name}` })),
      ]
    : [];

  // Cross-topic "Recorded on Base" entry — opens the dedicated screen
  // backed by GET /api/recorded. Wrapped in useAuthGuardedAction because
  // the endpoint requires authentication; guests see the sign-in sheet
  // and the navigation auto-replays after sign-in.
  const handleOpenRecorded = useAuthGuardedAction(() => {
    navigation.navigate('RecordedFeed');
  });

  const ListHeader = (
    <View>
      <View style={styles.recordedChipWrap}>
        <TouchableOpacity
          style={styles.recordedChip}
          activeOpacity={0.7}
          onPress={handleOpenRecorded}
          accessibilityRole="button"
          accessibilityLabel={t('openstoa.feed.recordedChip')}
        >
          <RecordIcon size={12} color="#a78bfa" />
          <Text style={styles.recordedChipText}>
            {t('openstoa.feed.recordedChip')}
          </Text>
        </TouchableOpacity>
      </View>
      <SortPills items={sortItems} value={sortKey} onChange={setSortKey} />
      {tagChips.length > 0 ? (
        <TagChips chips={tagChips} value={activeTag} onChange={setActiveTag} />
      ) : null}
    </View>
  );

  const ListFooter = isFetchingNextPage ? (
    <ActivityIndicator style={styles.footerSpinner} color={colors.brand.primary} />
  ) : null;

  const stickySearchBar = (
    <SearchBar
      value={searchDraft}
      onChangeText={setSearchDraft}
      onSubmit={(v) => setQ(v.trim())}
      onClear={() => { setSearchDraft(''); setQ(''); }}
      placeholder={t('openstoa.feed.searchPlaceholder')}
    />
  );

  if (isLoading) {
    return (
      <View style={styles.root}>
        {stickySearchBar}
        {ListHeader}
        <View style={styles.centeredContent}>
          <ActivityIndicator size="large" color={colors.brand.primary} />
        </View>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.root}>
        {stickySearchBar}
        {ListHeader}
        <View style={styles.centeredContent}>
          <Text style={styles.errorText}>{t('openstoa.feed.error')}</Text>
          <Text style={styles.retryText} onPress={() => void refetch()}>
            {t('openstoa.common.retry')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {stickySearchBar}
      <FlatList<Post>
        data={posts}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        ListFooterComponent={ListFooter}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>{t('openstoa.feed.empty')}</Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.brand.primary}
          />
        }
        contentContainerStyle={posts.length === 0 ? styles.emptyContent : styles.list}
      />
    </View>
  );
}
