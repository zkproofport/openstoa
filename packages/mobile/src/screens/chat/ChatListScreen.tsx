import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { usePendingChatTopicId } from '../../hooks/usePushTapRouting';
import { takePendingChatTopicId } from '../../hooks/pushTapRouting';
import type { ChatMessage, Topic } from '@openstoa/api-types';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';

interface ChatHistoryResponse {
  messages: ChatMessage[];
  total: number;
}

const AVATAR_SIZE = 44;
const UNREAD_BADGE_SIZE = 18;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: colors.background.primary,
    },
    listContent: { paddingVertical: 4 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border.default,
      marginLeft: 16 + AVATAR_SIZE + 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: colors.background.primary,
    },
    avatar: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
      flexShrink: 0,
    },
    avatarText: {
      fontSize: TYPE_SCALE.bodyLarge,
      fontWeight: '700',
      color: colors.brand.primary,
    },
    rowContent: { flex: 1 },
    rowTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 3,
    },
    topicTitle: {
      flex: 1,
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.text.primary,
      marginRight: 8,
    },
    topicTitleUnread: {
      fontWeight: '700',
    },
    time: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      flexShrink: 0,
    },
    lastMessage: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
    },
    lastMessageUnread: {
      color: colors.text.primary,
      fontWeight: '500',
    },
    loadingIndicator: {
      alignSelf: 'flex-start',
    },
    // Unread badge
    unreadBadge: {
      minWidth: UNREAD_BADGE_SIZE,
      height: UNREAD_BADGE_SIZE,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 5,
      marginLeft: 6,
      flexShrink: 0,
    },
    unreadBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700',
      color: '#FFFFFF',
    },
    rowRight: {
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 4,
      marginLeft: 4,
      flexShrink: 0,
    },
    emptyTitle: {
      fontSize: TYPE_SCALE.bodyLarge,
      fontWeight: '600',
      color: colors.text.primary,
    },
    emptyBody: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      marginTop: 8,
      textAlign: 'center',
      lineHeight: 20,
    },
    errorTitle: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '600',
      color: colors.status.danger,
    },
    errorBody: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      marginTop: 6,
      textAlign: 'center',
    },
    retryBtn: {
      marginTop: 16,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
    },
    retryLabel: { color: '#FFFFFF', fontWeight: '600' },
  });
}

// Simple unread heuristic: we track the last-seen message id per topic in
// memory. A topic row is "unread" when the latest message id differs from
// the last one the user opened. The badge shows total unread count
// (capped at 99). This resets when the user navigates into the room.
const seenMessageIds = new Map<string, string>();

export function ChatListScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const sessionUserId = useOpenStoaSession((s: { userId: string | null }) => s.userId);
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  // Chat is a fully-authenticated tab — guests see a Sign-in card instead.
  // We still call the hooks below unconditionally so rules-of-hooks holds,
  // but gate `enabled` so guests don't fire 401s in a loop.
  const { isGuest } = useRequireAuth();

  // NOTE: push registration used to live here. It now runs at the mini-app root
  // (`OpenStoaApp`) so a user who never opens this screen still registers.

  // Without view=all, /api/topics returns only joined topics for authenticated
  // users (verified via openstoa/src/app/api/topics/route.ts).
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['my-topics'],
    queryFn: () => client.get<{ topics: Topic[] } | Topic[]>('/api/topics'),
    enabled: !isGuest,
  });

  const topics: Topic[] = Array.isArray(data) ? data : (data?.topics ?? []);

  // Push tap routing, step 2 of 2 (design §13, P-O gap 5): open the room the
  // notification came from. Done from HERE, not from the tab navigator, so the
  // chat list stays underneath and the room has a working Back button.
  //
  // `useEffect`, not `useFocusEffect`: when the user is already inside another
  // room this screen is mounted but NOT focused, and a focus-gated version
  // would sit on the tap until they manually backed out.
  const pendingChatTopicId = usePendingChatTopicId();
  const topicsRef = React.useRef<Topic[]>(topics);
  topicsRef.current = topics;
  useEffect(() => {
    // Guests have no rooms to open. The latch is dropped by usePushTapRouting
    // once boot resolves to a guest, so nothing accumulates here.
    if (isGuest || !pendingChatTopicId) return;
    const topicId = takePendingChatTopicId();
    if (!topicId) return;
    // Title is a nicety for the header; the room screen falls back on its own
    // when the topic list hasn't loaded yet (or the user isn't a member).
    const topicTitle = topicsRef.current.find((topic) => topic.id === topicId)?.title;
    navigation.navigate('ChatRoom', { topicId, topicTitle, kind: 'topic' });
  }, [pendingChatTopicId, isGuest, navigation]);

  // Fetch the latest chat message per topic in parallel. Cached for 30s so
  // pull-to-refresh on the topics list won't hammer chat history.
  const chatQueries = useQueries({
    queries: topics.map((topic) => ({
      queryKey: ['chat-last', topic.id],
      queryFn: () =>
        client.get<ChatHistoryResponse>(`/api/topics/${topic.id}/chat?limit=1`),
      enabled: !isGuest && !!topic.id,
      staleTime: 30_000,
    })),
  });

  // Sort topics by last message time (most recent first).
  const sortedTopics = useMemo(() => {
    return [...topics].sort((a, b) => {
      const indexA = topics.indexOf(a);
      const indexB = topics.indexOf(b);
      const lastMsgA = chatQueries[indexA]?.data?.messages?.[0];
      const lastMsgB = chatQueries[indexB]?.data?.messages?.[0];
      if (!lastMsgA && !lastMsgB) {
        // Fall back to topic creation time
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (!lastMsgA) return 1;
      if (!lastMsgB) return -1;
      return new Date(lastMsgB.createdAt).getTime() - new Date(lastMsgA.createdAt).getTime();
    });
  }, [topics, chatQueries]);

  // Re-sync the last-message preview whenever the list regains focus. A
  // message the user just sent in a ChatRoom is persisted server-side but
  // the cached `chat-last` query stays fresh for 30s, so navigating back
  // showed the OLD last message. Invalidating on focus forces each row to
  // refetch its latest message (and the topic list itself, for new rooms).
  useFocusEffect(
    useCallback(() => {
      if (isGuest) return;
      queryClient.invalidateQueries({ queryKey: ['chat-last'] });
      queryClient.invalidateQueries({ queryKey: ['my-topics'] });
    }, [queryClient, isGuest]),
  );

  if (isGuest) {
    // Same component as ProfileTab's guest fallback so the two tabs
    // render with identical padding / card size — the user kept seeing
    // inconsistent widths when each screen rolled its own wrapper.
    return <GuestFallbackView />;
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.brand.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>{t('openstoa.chat.error.title')}</Text>
        <Text style={styles.errorBody}>{(error as Error).message}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryLabel}>{t('openstoa.common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (topics.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t('openstoa.chat.empty.title')}</Text>
        <Text style={styles.emptyBody}>{t('openstoa.chat.empty.body')}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={sortedTopics}
      keyExtractor={(topic) => topic.id}
      refreshing={isRefetching}
      onRefresh={() => refetch()}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => {
        const originalIndex = topics.indexOf(item);
        const chatQuery = chatQueries[originalIndex];
        const lastMessage = chatQuery?.data?.messages?.[0];
        const chatLoading = chatQuery?.isLoading ?? false;

        // Unread: message present, different from last-seen id, AND not
        // authored by me. A message I just sent is the latest row but must
        // never count as "unread" — that produced the bogus "1" badge on a
        // topic where my own message was the most recent one.
        const lastSeenId = seenMessageIds.get(item.id);
        const hasUnread =
          lastMessage != null &&
          lastMessage.type === 'message' &&
          lastMessage.id !== lastSeenId &&
          lastMessage.userId !== sessionUserId;
        // We show badge "1" when unread — no per-topic count without
        // a dedicated unread API; presence of any new message is enough.
        const unreadCount = hasUnread ? 1 : 0;

        return (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => {
              // Mark as seen before navigating
              if (lastMessage) {
                seenMessageIds.set(item.id, lastMessage.id);
              }
              navigation.navigate('ChatRoom', {
                topicId: item.id,
                topicTitle: item.title,
                kind: 'topic',
              });
            }}
          >
            {/* Avatar — first letter of topic title */}
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {item.title.slice(0, 1).toUpperCase()}
              </Text>
            </View>

            {/* Main content */}
            <View style={styles.rowContent}>
              <View style={styles.rowTop}>
                <Text
                  style={[styles.topicTitle, hasUnread && styles.topicTitleUnread]}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
              </View>

              {chatLoading ? (
                <ActivityIndicator
                  size="small"
                  color={colors.text.tertiary}
                  style={styles.loadingIndicator}
                />
              ) : (
                <Text
                  style={[styles.lastMessage, hasUnread && styles.lastMessageUnread]}
                  numberOfLines={1}
                >
                  {lastMessage
                    ? lastMessage.type === 'message'
                      ? // E2EE user messages carry no plaintext on the wire (body
                        // is in `sealed`). Decrypting here is unsafe — open() would
                        // bootstrap/rejoin the MLS group and churn epochs just from
                        // viewing the list — so show a placeholder instead.
                        `${lastMessage.nickname}: ${t('openstoa.chat.encryptedMessage')}`
                      : // System rows (join/leave) carry public text in `message`.
                        `${lastMessage.nickname}: ${lastMessage.message}`
                    : t('openstoa.chat.noMessagesYet')}
                </Text>
              )}
            </View>

            {/* Right column: time + unread badge */}
            <View style={styles.rowRight}>
              {lastMessage ? (
                <Text style={styles.time}>
                  {formatRelativeTime(lastMessage.createdAt)}
                </Text>
              ) : null}
              {unreadCount > 0 ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>
                    {unreadCount > 99 ? '99+' : String(unreadCount)}
                  </Text>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      }}
      contentContainerStyle={styles.listContent}
    />
  );
}
