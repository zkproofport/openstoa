import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
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
import { filterByQuery } from '../../utils/searchFilter';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';

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
  const [search, setSearch] = useState('');

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
    queryKey: ['feed', sortKey, activeTag],
    queryFn: async ({ pageParam }) => {
      const offset = (pageParam as number | undefined) ?? 0;
      const params = new URLSearchParams({
        limit: '20',
        offset: String(offset),
        sort: sortKey,
      });
      if (activeTag) params.set('tag', activeTag);
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
  const dedupedPosts: Post[] = [];
  for (const p of rawPosts) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      dedupedPosts.push(p);
    }
  }
  // Client-side filter over what's already been paginated in (title,
  // body, author, tags). Topic is intentionally NOT a search field on
  // the feed — finding a topic is the Topics tab's job. No server
  // `?q=` yet, so this is bounded by however far the user has
  // scrolled. When a server full-text endpoint lands we can drop this
  // in favour of a debounced query without changing the markup.
  type PostWithExtras = Post & {
    tags?: { name?: string }[];
  };
  const posts: Post[] = filterByQuery(dedupedPosts, search, (p) => {
    const pp = p as PostWithExtras;
    const tagNames = (pp.tags ?? []).map((t) => t.name);
    return [pp.title, pp.content, pp.authorNickname, ...tagNames];
  });

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

  const ListHeader = (
    <View>
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder={t('openstoa.feed.searchPlaceholder')}
      />
      <SortPills items={sortItems} value={sortKey} onChange={setSortKey} />
      {tagChips.length > 0 ? (
        <TagChips chips={tagChips} value={activeTag} onChange={setActiveTag} />
      ) : null}
    </View>
  );

  const ListFooter = isFetchingNextPage ? (
    <ActivityIndicator style={styles.footerSpinner} color={colors.brand.primary} />
  ) : null;

  if (isLoading) {
    return (
      <View style={styles.root}>
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
      style={styles.root}
    />
  );
}
