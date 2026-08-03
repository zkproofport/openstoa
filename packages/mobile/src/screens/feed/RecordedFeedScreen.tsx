import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { Post } from '@openstoa/api-types';
import type { FeedStackParamList } from '../../navigation/stacks/FeedStack';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { PostCard } from '../../components/PostCard';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { TYPE_SCALE } from '../../theme/tokens';

// Cross-topic feed of every post the calling user has recorded on-chain
// (server returns posts they recorded in any topic they're still a member
// of). Mirrors the web `/recorded` page: paginated, infinite-scroll, same
// PostCard render. Distinct from the per-profile "Recorded" tab — this is
// the community-wide view.
//
// Server contract: `GET /api/recorded?limit=&offset=` → `{ posts: Post[] }`.
// 401 for guests — we surface a "sign in" empty state instead of crashing.

const PAGE_SIZE = 20;

type RecordedNavProp = NativeStackNavigationProp<FeedStackParamList, 'RecordedFeed'>;

interface RecordedPage {
  posts: Post[];
  nextOffset?: number;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    list: { flexGrow: 1 },
    emptyContent: { flexGrow: 1 },
    centeredContent: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    header: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 12,
      backgroundColor: colors.background.primary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    title: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
      marginBottom: 4,
    },
    subtitle: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },
    errorText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.status.danger,
      marginBottom: 12,
      textAlign: 'center',
    },
    retryText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.brand.primary,
      fontWeight: '600',
    },
    emptyWrap: {
      paddingVertical: 80,
      alignItems: 'center',
      paddingHorizontal: 24,
    },
    emptyText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
      textAlign: 'center',
    },
    footerSpinner: { paddingVertical: 16 },
  });
}

export function RecordedFeedScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<RecordedNavProp>();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useInfiniteQuery<RecordedPage>({
    queryKey: ['feed', 'recorded'],
    queryFn: async ({ pageParam }) => {
      const offset = (pageParam as number | undefined) ?? 0;
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const res = await client.get<{ posts: Post[] }>(
        `/api/recorded?${params.toString()}`,
      );
      const posts = res.posts ?? [];
      // Pagination is offset-based; advance only when we received a full
      // page (server returns < limit when there's no more).
      return {
        posts,
        nextOffset: posts.length === PAGE_SIZE ? offset + PAGE_SIZE : undefined,
      };
    },
    initialPageParam: 0 as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });

  // Defensive dedup — same pattern as FeedHomeScreen — protects against
  // overlap between consecutive pages on offset-based pagination.
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
      <PostCard
        post={item}
        topicTitle={item.topicTitle}
        onPress={() => handlePressPost(item.id)}
      />
    ),
    [handlePressPost],
  );

  const keyExtractor = useCallback((item: Post) => item.id, []);

  const ListHeader = (
    <View style={styles.header}>
      <Text style={styles.title}>{t('openstoa.feed.recordedTitle')}</Text>
      <Text style={styles.subtitle}>{t('openstoa.feed.recordedSubtitle')}</Text>
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
          <Text style={styles.errorText}>{t('openstoa.feed.recordedError')}</Text>
          <Text style={styles.retryText} onPress={() => void refetch()}>
            {t('openstoa.common.retry')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
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
            <Text style={styles.emptyText}>{t('openstoa.feed.recordedEmpty')}</Text>
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
