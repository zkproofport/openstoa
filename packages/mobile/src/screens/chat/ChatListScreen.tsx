import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
import { sortConversationsByActivity } from '../../lib/chatSort';
import { useRequireAuth, GuestFallbackView } from '../../auth';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { QueryErrorState } from '../../components/QueryErrorState';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { usePendingChatTopicId } from '../../hooks/usePushTapRouting';
import { takePendingChatTopicId } from '../../hooks/pushTapRouting';
import {
  getChatReadCursor,
  getChatReadCursorVersion,
  markChatRead,
  subscribeChatReadCursors,
  type ChatReadCursor,
} from '../../lib/chatReadCursor';
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
  });
}

// The read marker used to live here, as a `Map<topicId, messageId>` written
// from a row's `onPress`. That made it a property of TAPPING A ROW rather than
// of having been in the room, so the push-notification route — the pending-tap
// effect below calls `navigation.navigate` and nothing else — recorded nothing,
// and backing out of a room reached that way left every message just read still
// badged. It now lives in `../../lib/chatReadCursor` and is written by
// `ChatRoomScreen`, which is the one thing every route into a room has in
// common. IN MEMORY still: a cold start has no cursor for a room not yet opened
// in this process, so its recent window counts as unread. See that module.

// How many messages the list pulls per topic. The badge renders anything past
// 99 as "99+", so 100 is exactly the window at which a wider fetch could no
// longer change what the user sees. It is also the whole reason this is one
// request and not two: the newest row doubles as the conversation preview.
const UNREAD_SCAN_LIMIT = 100;

// While the list is on screen, re-pull each room's window on this cadence.
// Without it the only refresh was `useFocusEffect`, so a message arriving while
// the user sat on the chat list did not move the badge until they navigated
// away and back — the "badge shows up late" report. Matches the query's own
// `staleTime` so a focus change and a tick never both fetch.
const UNREAD_POLL_MS = 30_000;

/**
 * How often to re-pull, or `false` for not at all.
 *
 * Exported and pure so the GATING RULE can be tested directly. It cannot be
 * tested through the rendered screen: react-query's `refetchInterval` does not
 * fire under vitest's fake timers (verified with a standalone probe — a plain
 * `useQuery` with `refetchInterval: 30_000` stays at one fetch across 62
 * simulated seconds), so a render-level poll test would assert nothing and pass
 * whether the poll worked or not. This pins the decision; that react-query then
 * honours it is the library's contract, not this screen's.
 */
export function unreadPollInterval(screenFocused: boolean, isGuest: boolean): number | false {
  // Guests fire no queries at all, and a blurred list stays mounted underneath
  // an open chat room — polling every room's history from there is pure waste.
  return screenFocused && !isGuest ? UNREAD_POLL_MS : false;
}

/**
 * Unread messages in a topic's newest-first window.
 *
 * Walks from the newest row and stops at the first one the viewer has already
 * accounted for:
 *   - the read cursor `ChatRoomScreen` left behind — either the very message
 *     it recorded, or anything no newer than it (see the note in the loop for
 *     why both, not just the id);
 *   - one of their OWN messages — sending is being in the room, so everything
 *     under it has been seen. This is what keeps a room whose last three rows
 *     are mine at zero rather than counting the older rows beneath them.
 * System rows (join / leave) are skipped rather than counted: they are public
 * furniture, not something to be unread about. They do not stop the walk either,
 * so a join notice between two new messages cannot hide the older one.
 */
export function countUnread(
  messages: ChatMessage[],
  cursor: ChatReadCursor | undefined,
  viewerId: string | null,
): number {
  const seenAt = cursor ? new Date(cursor.createdAt).getTime() : NaN;
  let unread = 0;
  for (const message of messages) {
    if (cursor && message.id === cursor.messageId) break;
    // The id alone is not enough. The room records a message the list may no
    // longer be holding — it was deleted, or more than `UNREAD_SCAN_LIMIT`
    // messages have landed since — and with only the id check the walk would
    // then run off the end of the window and report everything as unread.
    if (Number.isFinite(seenAt) && new Date(message.createdAt).getTime() <= seenAt) break;
    if (viewerId != null && message.userId === viewerId) break;
    if (message.type !== 'message') continue;
    unread += 1;
  }
  return unread;
}

export function ChatListScreen() {
  const { t } = useTranslation();
  const client = useOpenStoaClient();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const sessionUserId = useOpenStoaSession((s: { userId: string | null }) => s.userId);
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  // Re-render when a room records how far it has been read. The cursors live in
  // a module-level map, not in React state, because the room that writes them is
  // a different screen on a different route — and the list is mounted underneath
  // it the whole time, so without this the badge would only be recomputed if
  // something else happened to re-render the row.
  useSyncExternalStore(
    subscribeChatReadCursors,
    getChatReadCursorVersion,
    getChatReadCursorVersion,
  );

  // Chat is a fully-authenticated tab — guests see a Sign-in card instead.
  // We still call the hooks below unconditionally so rules-of-hooks holds,
  // but gate `enabled` so guests don't fire 401s in a loop.
  const { isGuest } = useRequireAuth();

  // NOTE: push registration used to live here. It now runs at the mini-app root
  // (`OpenStoaApp`) so a user who never opens this screen still registers.

  // Without view=all, /api/topics returns only joined topics for authenticated
  // users (verified via openstoa/src/app/api/topics/route.ts).
  // Drives the poll below. `useFocusEffect` rather than `useIsFocused` because
  // this screen already depends on it (and it stays mounted underneath an open
  // chat room, where polling every room's history would be pure waste).
  const [screenFocused, setScreenFocused] = useState(false);
  /** True only while a pull-to-refresh the user started is in flight. */
  const [pulling, setPulling] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-topics'],
    queryFn: () => client.get<{ topics: Topic[] } | Topic[]>('/api/topics'),
    enabled: !isGuest,
    refetchInterval: unreadPollInterval(screenFocused, isGuest),
  });

  const topics: Topic[] = Array.isArray(data) ? data : (data?.topics ?? []);

  /*
   * Seed the in-memory cursor cache from the server's ACCOUNT-level one.
   *
   * This is the half of the fix a client cannot do alone. The cache is per
   * process, so before this every cold start had no cursor for any room not yet
   * opened in that process and counted its whole recent window as unread — and
   * a room read on the phone stayed badged on the web forever, because the two
   * caches never met. `/api/topics` now carries the cursor, so the first list
   * fetch after launch already knows.
   *
   * `markChatRead` rather than a direct write: it is monotonic, so a cursor this
   * process has already pushed FURTHER (the user read a room a second ago and
   * the debounced PUT has not landed) is never dragged back by a server response
   * that predates it.
   */
  useEffect(() => {
    for (const topic of topics) {
      const t = topic as Topic & { lastReadMessageId?: string | null; lastReadAt?: string | null };
      if (!t.lastReadMessageId || !t.lastReadAt) continue;
      markChatRead(t.id, { id: t.lastReadMessageId, createdAt: t.lastReadAt });
    }
  }, [topics]);

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

  // Fetch each topic's newest messages in parallel. `UNREAD_SCAN_LIMIT`, not 1:
  // the row needs both the newest message (preview) and enough of the window
  // behind it to COUNT the unread ones — with `limit=1` there was nothing to
  // count, which is why the badge was hard-wired to "1". Cached for 30s so
  // pull-to-refresh on the topics list won't hammer chat history.
  const chatQueries = useQueries({
    queries: topics.map((topic) => ({
      queryKey: ['chat-last', topic.id],
      queryFn: () =>
        client.get<ChatHistoryResponse>(
          `/api/topics/${topic.id}/chat?limit=${UNREAD_SCAN_LIMIT}`,
        ),
      enabled: !isGuest && !!topic.id,
      staleTime: 30_000,
      refetchInterval: unreadPollInterval(screenFocused, isGuest),
    })),
  });

  // Newest activity first. The rule itself lives in `lib/chatSort` because the
  // web list had its own (none — it showed creation order), so the same account
  // saw two different conversation orders depending on the device.
  const sortedTopics = useMemo(
    () =>
      sortConversationsByActivity(
        topics,
        (topic) => (topic as { lastChatAt?: string | null }).lastChatAt,
      ),
    [topics],
  );

  // Re-sync the last-message preview whenever the list regains focus. A
  // message the user just sent in a ChatRoom is persisted server-side but
  // the cached `chat-last` query stays fresh for 30s, so navigating back
  // showed the OLD last message. Invalidating on focus forces each row to
  // refetch its latest message (and the topic list itself, for new rooms).
  useFocusEffect(
    useCallback(() => {
      setScreenFocused(true);
      if (!isGuest) {
        queryClient.invalidateQueries({ queryKey: ['chat-last'] });
        queryClient.invalidateQueries({ queryKey: ['my-topics'] });
      }
      // Stop the poll on blur — the screen stays mounted under an open room.
      return () => setScreenFocused(false);
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
      <QueryErrorState
        title={t('openstoa.chat.error.title')}
        error={error}
        onRetry={() => refetch()}
      />
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
      /*
       * `pulling`, NOT react-query's `isRefetching`.
       *
       * `isRefetching` is true for ANY background fetch, and this list polls
       * every 30 seconds — so the pull-to-refresh spinner appeared on its own
       * every poll, with nobody having pulled anything. Coming back from a push
       * notification re-focuses the screen and restarts the poll, which is why
       * it read as "the spinner is stuck after a notification".
       *
       * A refresh control is a statement about what the USER asked for. Only a
       * pull sets this.
       */
      refreshing={pulling}
      onRefresh={async () => {
        setPulling(true);
        try {
          await refetch();
        } finally {
          // `finally`: a refetch that rejects must still put the spinner away,
          // or a single failed pull leaves it turning until the screen unmounts.
          setPulling(false);
        }
      }}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => {
        const originalIndex = topics.indexOf(item);
        const chatQuery = chatQueries[originalIndex];
        const messages = chatQuery?.data?.messages ?? [];
        const lastMessage = messages[0];
        const chatLoading = chatQuery?.isLoading ?? false;

        // A real count over the fetched window, not `hasUnread ? 1 : 0`. See
        // `countUnread` for the walk, including why a message I sent myself
        // ends it — that rule is what kept the bogus "1" off a topic whose
        // newest row is mine, and it is preserved here.
        const unreadCount = countUnread(messages, getChatReadCursor(item.id), sessionUserId);
        const hasUnread = unreadCount > 0;

        return (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => {
              // Deliberately does NOT mark anything read. The room does that,
              // from the messages it actually rendered — marking here as well
              // would make this route look correct while every other route into
              // the room (a push tap, above) stayed broken, which is the exact
              // shape of the defect this replaced.
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
