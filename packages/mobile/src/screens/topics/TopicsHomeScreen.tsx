import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
  TextInput,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from 'react-native-vector-icons/Feather';
import type { Topic } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { TopicCard } from '../../components/TopicCard';
import { SortPills } from '../../components/SortPills';
import { TagChips } from '../../components/TagChips';
import { InvitePromptModal } from '../../components/InvitePromptModal';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { TopicsStackParamList } from '../../navigation/stacks/TopicsStack';

type Nav = NativeStackNavigationProp<TopicsStackParamList, 'TopicsHome'>;

interface TopicsListResponse {
  topics: Topic[];
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
      fontSize: 15,
      color: colors.text.tertiary,
    },
    sectionHeader: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 6,
    },
    sectionTitle: {
      fontSize: 13,
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
    searchRow: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
      backgroundColor: colors.background.secondary,
    },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.background.tertiary,
      paddingHorizontal: 12,
      gap: 8,
    },
    searchIcon: {
      fontSize: 14,
      color: colors.text.tertiary,
    },
    searchInput: {
      flex: 1,
      height: 38,
      fontSize: 14,
      color: colors.text.primary,
      padding: 0,
    },
    filterRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: colors.background.secondary,
    },
    filterChip: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.tertiary,
    },
    filterChipActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    filterChipText: {
      fontSize: 13,
      color: colors.text.secondary,
      fontWeight: '500',
    },
    filterChipTextActive: {
      color: colors.brand.primary,
      fontWeight: '700',
    },
  });
}

export function TopicsHomeScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  const [sortKey, setSortKey] = useState<SortKey>('hot');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membershipFilter, setMembershipFilter] = useState<'all' | 'joined'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Single unified query: server returns every visible topic with an
  // `isMember` flag. Filtering by "joined" and searching by title both
  // happen client-side against this list so the user can flip between
  // views instantly without re-hitting the API.
  const topicsQuery = useQuery<Topic[]>({
    queryKey: ['topics', 'all', sortKey, activeCategory],
    queryFn: async () => {
      const params = new URLSearchParams({ view: 'all', sort: sortKey });
      if (activeCategory) params.set('category', activeCategory);
      const res = await client.get<TopicsListResponse>(`/api/topics?${params.toString()}`);
      return res.topics ?? [];
    },
  });

  const categoriesQuery = useQuery<CategoriesResponse>({
    queryKey: ['categories'],
    queryFn: () => client.get<CategoriesResponse>('/api/categories'),
    staleTime: 5 * 60_000,
  });

  const inviteJoinMutation = useMutation({
    mutationFn: async (code: string) => {
      return client.post<InviteJoinResponse>(`/api/topics/join/${encodeURIComponent(code)}`);
    },
    onSuccess: (res) => {
      setInviteOpen(false);
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      navigation.navigate('TopicDetail', { topicId: res.topicId });
    },
    onError: (err: Error) => {
      const msg = err.message.includes('409')
        ? t('openstoa.topics.invite.alreadyMember')
        : err.message.includes('404')
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
            onPress={() => setInviteOpen(true)}
            style={styles.headerButton}
            accessibilityLabel={t('openstoa.topics.invite.cta')}
          >
            <Feather name="link" size={20} color={colors.brand.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('TopicCreate')}
            style={styles.headerButton}
          >
            <Feather name="plus" size={22} color={colors.brand.primary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, t, colors, styles]);

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

  // Apply membership filter + search client-side. The server already
  // attaches `isMember` per topic so no extra request is needed.
  const visibleTopics = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    return allTopics.filter((tt) => {
      if (membershipFilter === 'joined' && !tt.isMember) return false;
      if (trimmed && !tt.title.toLowerCase().includes(trimmed)) return false;
      return true;
    });
  }, [allTopics, membershipFilter, searchQuery]);

  const Header = (
    <View>
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Feather name="search" size={16} color={colors.text.tertiary} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('openstoa.topics.searchPlaceholder', { defaultValue: 'Search topics' })}
            placeholderTextColor={colors.text.tertiary}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>
      <View style={styles.filterRow}>
        <TouchableOpacity
          style={[styles.filterChip, membershipFilter === 'all' && styles.filterChipActive]}
          onPress={() => setMembershipFilter('all')}
        >
          <Text style={[styles.filterChipText, membershipFilter === 'all' && styles.filterChipTextActive]}>
            {t('openstoa.topics.filter.all', { defaultValue: 'All' })}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterChip, membershipFilter === 'joined' && styles.filterChipActive]}
          onPress={() => setMembershipFilter('joined')}
        >
          <Text style={[styles.filterChipText, membershipFilter === 'joined' && styles.filterChipTextActive]}>
            {t('openstoa.topics.filter.joined', { defaultValue: 'Joined' })}
          </Text>
        </TouchableOpacity>
      </View>
      <SortPills items={sortItems} value={sortKey} onChange={setSortKey} />
      {categoryChips.length > 1 ? (
        <TagChips chips={categoryChips} value={activeCategory} onChange={setActiveCategory} />
      ) : null}
    </View>
  );

  return (
    <View style={styles.root}>
      {isLoading ? (
        <View style={styles.list}>
          {Header}
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand.primary} />
          </View>
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
                {searchQuery.trim()
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
        onSubmit={(code) => inviteJoinMutation.mutateAsync(code).catch(() => undefined)}
        submitting={inviteJoinMutation.isPending}
      />
    </View>
  );
}
