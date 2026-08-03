import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
import { SettingsIcon } from '../../components/icons';
import { SearchBar } from '../../components/SearchBar';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHost } from '@openstoa/miniapp-bridge';
import type { Badge, DomainBadgeStatus, Post, SessionInfo } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { PostCard } from '../../components/PostCard';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import type { ProfileStackParamList } from '../../navigation/stacks/ProfileStack';
import { formatRelativeTime } from '../../utils/relativeTime';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';

type ProfileNavProp = NativeStackNavigationProp<ProfileStackParamList, 'ProfileHome'>;

// Likes was removed when up/down voting replaced the legacy "like only"
// model — every upvoted post is exposed via the vote count anyway, and
// keeping a separate Likes tab confused users about what it meant.
// Topics was removed because it duplicated the dedicated bottom-nav
// Topics tab (which already provides Joined / Explore filters).
type TabKey = 'posts' | 'bookmarks' | 'recorded';

// Within the Recorded tab there are two related-but-distinct lists:
//   'by-me'   — posts I have recorded on-chain (my activity).
//   'on-mine' — my authored posts that someone has recorded
//               (my achievement; mirrors the inline "My posts recorded
//                N times on Base" banner on the Posts tab).
type RecordedSubKey = 'by-me' | 'on-mine';

interface MyPostsResponse {
  posts: Post[];
}

/** Session response includes totalRecorded — see openstoa /api/auth/session */
interface SessionWithStats extends SessionInfo {
  totalRecorded?: number;
  profileImage?: string | null;
  role?: string;
}

interface MyTopicsResponse {
  topics: Array<{ id: string; title: string; image?: string | null; memberCount?: number }>;
}

interface ProfileImageResponse {
  profileImage: string | null;
}

// Maps the proof-type string returned by /api/profile/badges to a short
// human label for chips. Mirrors the proof type IDs in `ProofType`
// (packages/api-types). Unknown types fall back to the raw string.
function badgeLabelFor(type: string): string {
  switch (type) {
    case 'kyc':
      return 'KYC';
    case 'country':
      return 'Country';
    case 'google_workspace':
      return 'Google Workspace';
    case 'microsoft_365':
      return 'Microsoft 365';
    case 'workspace':
      return 'Workspace';
    default:
      return type;
  }
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background.secondary,
    },
    listContent: {
      flexGrow: 1,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: colors.background.primary,
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

    // Header
    header: {
      backgroundColor: colors.background.primary,
      alignItems: 'center',
      paddingTop: 24,
      paddingBottom: 20,
      paddingHorizontal: 16,
      position: 'relative',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    editButton: {
      position: 'absolute',
      top: 12,
      right: 12,
      // 36pt icon, 44pt target: the gear grows its hit area
      // outward without moving the glyph, which stays centered.
      width: TOUCH_TARGET_MIN,
      height: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editButtonText: {
      fontSize: TYPE_SCALE.headingSmall,
      lineHeight: 24,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    avatarCircle: {
      width: 72,
      height: 72,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
    },
    avatarImage: {
      width: 72,
      height: 72,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.tertiary,
      marginBottom: 8,
    },
    avatarInitial: {
      fontSize: TYPE_SCALE.headingLarge,
      fontWeight: '700',
      color: colors.brand.primary,
    },
    editPhotoText: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
      color: colors.brand.primary,
      marginBottom: 8,
    },
    nickname: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
      marginBottom: 4,
    },
    userId: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      fontFamily: 'monospace',
      marginBottom: 4,
    },
    recorded: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
      marginBottom: 4,
    },
    joinedAt: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },

    // Domain badge
    domainBadgeSection: {
      backgroundColor: colors.background.primary,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    domainBadgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    domainText: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.secondary,
      marginTop: 2,
    },
    toggleButton: {
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
    },
    toggleButtonActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    toggleButtonInactive: {
      backgroundColor: colors.background.secondary,
      borderColor: colors.border.strong,
    },
    toggleButtonText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700',
    },
    toggleButtonTextActive: {
      color: colors.brand.primary,
    },
    toggleButtonTextInactive: {
      color: colors.text.tertiary,
    },

    // Badges
    badgesSection: {
      backgroundColor: colors.background.primary,
      paddingHorizontal: 16,
      paddingVertical: 12,
      marginTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    badgeScroll: {
      marginTop: 8,
    },
    badgeChip: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.pill,
      paddingHorizontal: 12,
      paddingVertical: 5,
      marginRight: 8,
    },
    badgeLabel: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },

    // Tab bar
    tabBar: {
      flexDirection: 'row',
      backgroundColor: colors.background.primary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
      marginTop: 8,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabActive: {
      borderBottomColor: colors.brand.primary,
    },
    tabText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '500',
      color: colors.text.tertiary,
    },
    tabTextActive: {
      color: colors.brand.primary,
      fontWeight: '700',
    },
    tabSpinner: {
      paddingVertical: 24,
    },

    // Strip rendered above each PostCard inside the Recorded → By me
    // sub-tab. Surfaces the user's specific BaseScan tx link so they
    // can verify the on-chain receipt without entering the post.
    myTxStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 6,
      backgroundColor: colors.brand.primaryMuted,
    },
    myTxStripText: {
      flex: 1,
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
      color: colors.brand.primary,
    },

    // Sub-tab bar (used inside Recorded tab to switch between "by me"
    // and "on my posts"). Lighter weight than the main tab bar so it
    // reads as a secondary control.
    subTabBar: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
      backgroundColor: colors.background.primary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    subTab: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.secondary,
    },
    subTabActive: {
      backgroundColor: colors.brand.primaryMuted,
    },
    subTabText: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '500',
      color: colors.text.secondary,
    },
    subTabTextActive: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
      color: colors.brand.primary,
    },

    // Empty
    emptyContainer: {
      alignItems: 'center',
      paddingVertical: 40,
      paddingHorizontal: 24,
    },
    emptyText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
      textAlign: 'center',
    },

    // Section label
    sectionLabel: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.text.tertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },

    // Header stats row — posts authored | times those posts were
    // recorded. Two compact stat blocks side-by-side instead of the
    // single-stat badge + a separate banner below the tab bar.
    statsRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: 32,
      marginTop: 4,
    },
    statBlock: {
      alignItems: 'center',
    },
    statNumber: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '800' as const,
      color: colors.brand.primary,
    },
    statLabel: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },

    // Admin chip
    adminChip: {
      marginLeft: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: RADIUS.control,
      backgroundColor: 'rgba(234,179,8,0.15)',
      borderWidth: 1,
      borderColor: 'rgba(234,179,8,0.3)',
    },
    adminChipText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700' as const,
      color: '#eab308',
    },

    // Recorded banner
    recordedBanner: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: 'rgba(139,92,246,0.08)',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(139,92,246,0.15)',
      marginBottom: 0,
    },
    recordedBannerText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: '#a78bfa',
      flex: 1,
    },
    recordedBannerBold: {
      fontWeight: '700' as const,
      color: '#a78bfa',
    },

    // My Topics list
    topicItem: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.background.primary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    topicInitial: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.control,
      backgroundColor: colors.brand.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      flexShrink: 0,
    },
    topicInitialText: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '700' as const,
      color: '#ffffff',
    },
    topicTitle: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600' as const,
      color: colors.text.primary,
    },
    topicMeta: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      marginTop: 2,
    },

    // Footer
    footerActions: {
      padding: 24,
      gap: 12,
    },
    footerButton: {
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: RADIUS.card,
      borderWidth: 1,
      borderColor: colors.border.strong,
      backgroundColor: colors.background.primary,
    },
    footerButtonText: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    footerButtonDanger: {
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: RADIUS.card,
      backgroundColor: colors.status.danger,
    },
    footerButtonDangerText: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: '#FFFFFF',
    },
  });
}

export function ProfileHomeScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const host = useHost();
  const navigation = useNavigation<ProfileNavProp>();

  // PostDetail and TopicDetail are registered on ProfileStack (see
  // navigation/stacks/ProfileStack.tsx), so navigating inside this stack
  // keeps the back arrow pointing at Profile instead of jumping to the
  // Feed/Topics tabs.
  const openPost = useCallback(
    (postId: string) => navigation.navigate('PostDetail', { postId }),
    [navigation],
  );
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('posts');
  const [recordedSub, setRecordedSub] = useState<RecordedSubKey>('by-me');
  const [searchDraft, setSearchDraft] = useState('');
  const [q, setQ] = useState('');
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  // Profile is a fully authenticated tab; guests get a Sign-in card.
  // We still declare every useQuery hook unconditionally (rules-of-hooks)
  // but gate `enabled` on auth so guests don't fire 401s in a loop.
  const { isGuest } = useRequireAuth();

  const sessionQuery = useQuery<SessionWithStats>({
    queryKey: ['session'],
    queryFn: () => client.get<SessionWithStats>('/api/auth/session'),
    enabled: !isGuest,
  });

  const profileImageQuery = useQuery<ProfileImageResponse>({
    queryKey: ['profile', 'image'],
    queryFn: () => client.get<ProfileImageResponse>('/api/profile/image'),
    enabled: !isGuest,
  });

  const badgesQuery = useQuery<Badge[]>({
    queryKey: ['profile', 'badges'],
    queryFn: async () => {
      const res = await client.get<{ badges: Badge[] }>('/api/profile/badges');
      return res.badges ?? [];
    },
    enabled: !isGuest,
  });

  const domainBadgeQuery = useQuery<DomainBadgeStatus>({
    queryKey: ['profile', 'domain-badge'],
    queryFn: async () => {
      const raw = await client.get<{ domains?: string[]; availableDomain?: string | null }>(
        '/api/profile/domain-badge',
      );
      const domains = raw.domains ?? [];
      return {
        domains,
        availableDomain: raw.availableDomain ?? null,
        enabled: domains.length > 0,
        domain: domains[0],
      };
    },
    enabled: !isGuest,
  });

  const postsQuery = useQuery<MyPostsResponse>({
    queryKey: ['my', 'posts', q],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' });
      if (q) params.set('q', q);
      return client.get<MyPostsResponse>(`/api/my/posts?${params.toString()}`);
    },
    enabled: !isGuest && activeTab === 'posts',
  });

  const bookmarksQuery = useQuery<MyPostsResponse>({
    queryKey: ['my', 'bookmarks', q],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' });
      if (q) params.set('q', q);
      return client.get<MyPostsResponse>(`/api/bookmarks?${params.toString()}`);
    },
    enabled: !isGuest && activeTab === 'bookmarks',
  });

  const recordedQuery = useQuery<MyPostsResponse>({
    queryKey: ['my', 'recorded', q],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' });
      if (q) params.set('q', q);
      return client.get<MyPostsResponse>(`/api/my/recorded?${params.toString()}`);
    },
    enabled: !isGuest && activeTab === 'recorded' && recordedSub === 'by-me',
  });

  const recordedOnMineQuery = useQuery<MyPostsResponse>({
    queryKey: ['my', 'recorded-on-mine', q],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' });
      if (q) params.set('q', q);
      return client.get<MyPostsResponse>(`/api/my/recorded-on-mine?${params.toString()}`);
    },
    enabled: !isGuest && activeTab === 'recorded' && recordedSub === 'on-mine',
  });

  const isRefreshing =
    sessionQuery.isRefetching ||
    profileImageQuery.isRefetching ||
    badgesQuery.isRefetching ||
    domainBadgeQuery.isRefetching;

  const handleRefresh = useCallback(() => {
    void sessionQuery.refetch();
    void profileImageQuery.refetch();
    void badgesQuery.refetch();
    void domainBadgeQuery.refetch();
    if (activeTab === 'posts') void postsQuery.refetch();
    if (activeTab === 'bookmarks') void bookmarksQuery.refetch();
    if (activeTab === 'recorded') {
      if (recordedSub === 'by-me') void recordedQuery.refetch();
      else void recordedOnMineQuery.refetch();
    }
  }, [activeTab, recordedSub, sessionQuery, profileImageQuery, badgesQuery, domainBadgeQuery, postsQuery, bookmarksQuery, recordedQuery, recordedOnMineQuery]);

  // Domain badge ON/OFF mirrors the web flow at openstoa/src/app/my/page.tsx.
  // The badge is just an opt-in toggle on top of a workspace verification
  // (Google Workspace / Microsoft 365) that the user already produced when
  // joining a workspace-gated topic — a generic Google login is NOT a
  // workspace proof and won't populate `availableDomain`. So:
  //   • If `availableDomain` is set → POST opts the cached domain in.
  //   • If not, show guidance to verify by joining a workspace topic.
  const handleDomainBadgeToggle = useCallback(async () => {
    const data = domainBadgeQuery.data;
    if (!data) return;
    if (data.enabled) {
      try {
        await client.delete('/api/profile/domain-badge');
        await queryClient.invalidateQueries({ queryKey: ['profile', 'domain-badge'] });
      } catch (e) {
        host.showError('E9001', { detail: String(e) });
      }
      return;
    }
    if (!data.availableDomain) {
      Alert.alert(
        t('openstoa.profile.domainBadge.enableTitle'),
        // Matches web copy in openstoa/src/app/my/page.tsx:877.
        'No workspace verification found. Join a workspace-gated topic with a Google Workspace or Microsoft 365 proof to unlock this badge.',
      );
      return;
    }
    try {
      await client.post('/api/profile/domain-badge');
      await queryClient.invalidateQueries({ queryKey: ['profile', 'domain-badge'] });
    } catch (e) {
      host.showError('E9000', { detail: e instanceof Error ? e.message : String(e) });
    }
  }, [domainBadgeQuery.data, client, queryClient, host, t]);

  // Settings icon (gear) → straight to Edit profile. Edit profile owns
  // logout / delete account / domain badge / nickname / photo, so there's
  // no extra modal layer in between.

  const rawActiveTabPosts =
    activeTab === 'posts'
      ? (postsQuery.data?.posts ?? [])
      : activeTab === 'bookmarks'
        ? (bookmarksQuery.data?.posts ?? [])
        : activeTab === 'recorded'
          ? (recordedSub === 'by-me'
              ? (recordedQuery.data?.posts ?? [])
              : (recordedOnMineQuery.data?.posts ?? []))
          : [];
  // De-duplicate by post.id to avoid "two children with the same key" warnings
  // when the backend returns overlapping ids (e.g. on tab switches with stale data).
  const seenPostIds = new Set<string>();
  const activeTabPosts: typeof rawActiveTabPosts = [];
  for (const p of rawActiveTabPosts) {
    if (!seenPostIds.has(p.id)) {
      seenPostIds.add(p.id);
      activeTabPosts.push(p);
    }
  }

  const activeTabLoading =
    activeTab === 'posts'
      ? postsQuery.isLoading
      : activeTab === 'bookmarks'
        ? bookmarksQuery.isLoading
        : activeTab === 'recorded'
          ? (recordedSub === 'by-me'
              ? recordedQuery.isLoading
              : recordedOnMineQuery.isLoading)
          : false;

  const postCount = postsQuery.data?.posts.length ?? 0;

  if (isGuest) {
    // Same shared component used by ChatListScreen so both guest tabs
    // render with identical padding / card size.
    return <GuestFallbackView />;
  }

  if (sessionQuery.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{t('openstoa.profile.failedToLoad')}</Text>
        <Text style={styles.retryText} onPress={() => void sessionQuery.refetch()}>
          {t('openstoa.common.retry')}
        </Text>
      </View>
    );
  }

  const session = sessionQuery.data;
  // session.userId can be missing if the server returned a partial response
  // (e.g. expired token, race during dev-login refresh). Guard against
  // undefined to prevent the screen from crashing while the next sessionQuery
  // refetch / refresh resolves.
  const shortId = session.userId ? session.userId.slice(0, 8) : '';
  const badges = badgesQuery.data ?? [];
  const domainBadge = domainBadgeQuery.data;
  const profileImage = profileImageQuery.data?.profileImage ?? session.profileImage ?? null;
  const totalRecorded = session.totalRecorded ?? 0;

  const tabLabels: Record<TabKey, string> = {
    posts: t('openstoa.profile.tabs.posts'),
    bookmarks: t('openstoa.profile.tabs.bookmarks'),
    recorded: t('openstoa.profile.tabs.recorded'),
  };

  // The recorded tab has two sub-views with different empty copy.
  const emptyText =
    activeTab === 'recorded'
      ? recordedSub === 'by-me'
        ? t('openstoa.profile.empty.recordedByMe')
        : t('openstoa.profile.empty.recordedOnMine')
      : activeTab === 'posts'
        ? t('openstoa.profile.empty.posts')
        : t('openstoa.profile.empty.bookmarks');

  return (
    <View style={styles.root}>
      <SectionList<Post, { key: string }>
        sections={[{ key: 'main', data: activeTabPosts }]}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled
        renderItem={({ item }) => {
          // The "by-me" sub-tab of the Recorded list ships an extra
          // `myTxExplorerUrl` per post that points at THIS user's
          // BaseScan transaction for that recording. Surface it as a
          // small link strip above the card so the user can verify
          // their own on-chain record without diving into the post.
          const myTxUrl =
            activeTab === 'recorded' && recordedSub === 'by-me'
              ? (item as Post & { myTxExplorerUrl?: string | null }).myTxExplorerUrl
              : null;
          return (
            <View>
              {myTxUrl ? (
                <TouchableOpacity
                  style={styles.myTxStrip}
                  activeOpacity={0.7}
                  onPress={() =>
                    navigation.navigate('InAppBrowser', {
                      url: myTxUrl,
                      title: t('openstoa.postDetail.viewOnBase'),
                    })
                  }
                >
                  <Feather name="anchor" size={12} color={colors.brand.primary} />
                  <Text style={styles.myTxStripText} numberOfLines={1}>
                    {t('openstoa.postDetail.viewOnBase')}
                  </Text>
                  <Feather name="external-link" size={11} color={colors.brand.primary} />
                </TouchableOpacity>
              ) : null}
              <PostCard post={item} onPress={() => openPost(item.id)} />
            </View>
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.brand.primary}
          />
        }
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {/* Header */}
            <View style={styles.header}>
              <TouchableOpacity
                style={styles.editButton}
                onPress={() => navigation.navigate('EditProfile')}
                accessibilityLabel={t('openstoa.profile.settingsA11y', { defaultValue: 'Settings' })}
              >
                <SettingsIcon size={22} color={colors.text.secondary} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => navigation.navigate('EditProfile')}
              >
                {profileImage ? (
                  <Image
                    source={{ uri: profileImage }}
                    style={styles.avatarImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.avatarCircle}>
                    <Text style={styles.avatarInitial}>
                      {session.nickname.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => navigation.navigate('EditProfile')}>
                <Text style={styles.editPhotoText}>{t('openstoa.profile.editPhoto')}</Text>
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.nickname}>{session.nickname}</Text>
                {session.role === 'admin' && (
                  <View style={styles.adminChip}>
                    <Text style={styles.adminChipText}>Admin</Text>
                  </View>
                )}
              </View>
              <Text style={styles.userId}>#{shortId}</Text>
              <Text style={styles.joinedAt}>
                {t('openstoa.profile.joined', { when: formatRelativeTime(new Date(session.verifiedAt).toISOString()) })}
              </Text>
              <View style={styles.statsRow}>
                <View style={styles.statBlock}>
                  <Text style={styles.statNumber}>{postCount}</Text>
                  <Text style={styles.statLabel}>{t('openstoa.profile.postsCount')}</Text>
                </View>
                <View style={styles.statBlock}>
                  <Text style={styles.statNumber}>{totalRecorded}</Text>
                  <Text style={styles.statLabel}>{t('openstoa.profile.recordedCount')}</Text>
                </View>
              </View>
            </View>

            {/* Domain badge section */}
            {domainBadgeQuery.data !== undefined && (
              <View style={styles.domainBadgeSection}>
                <View style={styles.domainBadgeRow}>
                  <View>
                    <Text style={styles.sectionLabel}>{t('openstoa.profile.domainBadge.label')}</Text>
                    {domainBadge?.enabled && domainBadge.domain ? (
                      <Text style={styles.domainText}>{domainBadge.domain}</Text>
                    ) : (
                      <Text style={styles.domainText}>{t('openstoa.profile.notSet')}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.toggleButton,
                      domainBadge?.enabled ? styles.toggleButtonActive : styles.toggleButtonInactive,
                    ]}
                    onPress={() => void handleDomainBadgeToggle()}
                  >
                    <Text
                      style={[
                        styles.toggleButtonText,
                        domainBadge?.enabled
                          ? styles.toggleButtonTextActive
                          : styles.toggleButtonTextInactive,
                      ]}
                    >
                      {domainBadge?.enabled ? 'OFF' : 'ON'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Badges */}
            {badges.length > 0 && (
              <View style={styles.badgesSection}>
                <Text style={styles.sectionLabel}>{t('openstoa.profile.badges')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.badgeScroll}>
                  {badges.map((badge) => (
                    // Server returns `{type, verifiedAt, expiresAt}` — no `id`
                    // or `label`. Derive a readable label from the proof
                    // type and key by type since each user has one badge
                    // per proof type.
                    <View key={badge.type} style={styles.badgeChip}>
                      <Text style={styles.badgeLabel}>{badgeLabelFor(badge.type)}</Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Tab selector — part of the non-sticky header, scrolls
                out of view normally. The sticky chrome below (Search +
                sub-tab) keeps the active filter affordances reachable
                while browsing. */}
            <View style={styles.tabBar}>
              {(['posts', 'bookmarks', 'recorded'] as TabKey[]).map((tab) => (
                <TouchableOpacity
                  key={tab}
                  style={[styles.tab, activeTab === tab && styles.tabActive]}
                  onPress={() => setActiveTab(tab)}
                >
                  <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                    {tabLabels[tab]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        }
        renderSectionHeader={() => (
          // Sticky block — when the user scrolls past the profile
          // header / tab selector, this block docks to the top of the
          // screen so search + sub-tab + the loading spinner stay
          // reachable without scrolling back up. `stickySectionHeadersEnabled`
          // is set on the SectionList above.
          <View style={{ backgroundColor: colors.background.primary }}>
            <SearchBar
              value={searchDraft}
              onChangeText={setSearchDraft}
              onSubmit={(v) => setQ(v.trim())}
              onClear={() => { setSearchDraft(''); setQ(''); }}
              placeholder={t('openstoa.profile.searchPlaceholder')}
            />
            {activeTab === 'recorded' && (
              <View style={styles.subTabBar}>
                {(['by-me', 'on-mine'] as RecordedSubKey[]).map((sub) => (
                  <TouchableOpacity
                    key={sub}
                    style={[styles.subTab, recordedSub === sub && styles.subTabActive]}
                    onPress={() => setRecordedSub(sub)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={
                        recordedSub === sub
                          ? styles.subTabTextActive
                          : styles.subTabText
                      }
                    >
                      {sub === 'by-me'
                        ? t('openstoa.profile.recordedSub.byMe')
                        : t('openstoa.profile.recordedSub.onMine')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {activeTabLoading && (
              <ActivityIndicator
                style={styles.tabSpinner}
                color={colors.brand.primary}
              />
            )}
          </View>
        )}
        ListEmptyComponent={
          activeTabLoading ? null : (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>{emptyText}</Text>
            </View>
          )
        }
        // Footer logout/delete buttons removed — destructive actions now live
        // behind the ⋯ menu in the header to prevent accidental taps.
      />
    </View>
  );
}
