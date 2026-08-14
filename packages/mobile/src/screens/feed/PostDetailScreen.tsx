import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Modal,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Post, Comment } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useAuthGuardedAction } from '../../auth';
import { usePostMutations } from '../../hooks/usePostMutations';
import { MediaGallery } from '../../components/MediaGallery';
import { PollRenderer } from '../../components/PollRenderer';
import { PostContent, extractMediaItems, stripVideoUrls } from '../../components/PostContent';
import { PostBodyWithOg } from '../../components/PostBodyWithOg';
import { absolutizeMediaUrl } from '../../utils/absolutizeMediaUrl';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, RecordIcon, TrashIcon } from '../../components/icons';
import Feather from 'react-native-vector-icons/Feather';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { RADIUS, TYPE_SCALE } from '../../theme/tokens';

// ---------------------------------------------------------------------------
// Lazy clipboard — same pattern as PostCard / ChatRoomScreen
// ---------------------------------------------------------------------------

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default;
function loadClipboard(): ClipboardModule | null {
  try {
    return (require('@react-native-clipboard/clipboard') as { default: ClipboardModule }).default;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return '';
  if (id.length <= head + tail + 3) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

// ---------------------------------------------------------------------------
// Avatar component (matches TopicMembersScreen pattern)
// ---------------------------------------------------------------------------

function Avatar({
  src,
  name,
  size,
  colors,
}: {
  src?: string | null;
  name?: string | null;
  size: number;
  colors: ThemeColors;
}) {
  const client = useOpenStoaClient();
  if (src) {
    return (
      <Image
        source={{ uri: absolutizeMediaUrl(src, client.getBaseUrl()) ?? undefined }}
        style={{ width: size, height: size, borderRadius: RADIUS.pill }}
        resizeMode="cover"
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: RADIUS.pill,
        backgroundColor: colors.background.tertiary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.4, color: colors.text.tertiary, fontWeight: '600' }}>
        {initials(name)}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Reaction types
// ---------------------------------------------------------------------------

interface Reaction {
  emoji: string;
  count: number;
  userReacted: boolean;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background.primary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    errorText: { fontSize: TYPE_SCALE.bodySmall, color: colors.status.danger, textAlign: 'center' },
    listContent: { paddingBottom: 16 },

    // Post header
    postHeader: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    topicRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
    },
    topicLabel: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    joinedBadge: {
      backgroundColor: colors.status.success + '22',
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    joinedBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.status.success,
    },
    // Pinned badge — sits alongside the topic chip / joined badge so a
    // pinned post reads as elevated the moment the detail view opens.
    pinnedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    pinnedBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700',
      color: colors.brand.primary,
    },
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    authorInfo: { flex: 1 },
    authorName: { fontSize: TYPE_SCALE.bodySmall, fontWeight: '600', color: colors.text.primary },
    authorMeta: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary, marginTop: 2 },
    headerKebab: { paddingHorizontal: 8, paddingVertical: 4 },
    headerKebabGlyph: { fontSize: TYPE_SCALE.headingSmall, color: colors.text.tertiary, lineHeight: 22 },

    // Title
    postTitleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
    },
    postTitlePinIcon: {
      marginTop: 8,
    },
    postTitle: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
      lineHeight: 30,
      flexShrink: 1,
    },

    // Tags
    tagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingHorizontal: 16,
      paddingBottom: 10,
    },
    tag: {
      backgroundColor: colors.brand.primaryMuted,
      borderRadius: RADIUS.control,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    tagText: {
      fontSize: TYPE_SCALE.label,
      color: colors.brand.primary,
      fontWeight: '500',
    },

    // Media
    mediaSection: { paddingHorizontal: 16, paddingBottom: 12 },

    // Action bar
    actionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border.default,
      gap: 16,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 2,
    },
    actionIcon: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.tertiary },
    actionIconActive: { fontSize: TYPE_SCALE.bodySmall },
    actionCount: { fontSize: TYPE_SCALE.label, color: colors.text.tertiary },
    actionCountActive: { fontSize: TYPE_SCALE.label },
    actionSpacer: { flex: 1 },
    votePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    votePillBtn: {
      paddingHorizontal: 3,
      paddingVertical: 2,
    },
    votePillCount: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.secondary,
      minWidth: 14,
      textAlign: 'center',
    },
    votePillCountActive: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '700',
    },

    // Emoji reactions row
    reactionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border.default,
    },
    reactionPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
    },
    reactionPillActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    reactionPillInactive: {
      backgroundColor: colors.background.secondary,
      borderColor: colors.border.default,
    },
    reactionEmoji: { fontSize: TYPE_SCALE.bodySmall },
    reactionCount: { fontSize: TYPE_SCALE.label, color: colors.text.tertiary },
    reactionCountActive: { fontSize: TYPE_SCALE.label, color: colors.brand.primary, fontWeight: '600' },
    addReactionBtn: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    addReactionText: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.tertiary },

    // Emoji picker modal
    pickerOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'flex-end',
    },
    pickerSheet: {
      backgroundColor: colors.background.secondary,
      borderTopLeftRadius: RADIUS.modal,
      borderTopRightRadius: RADIUS.modal,
      paddingVertical: 16,
      paddingHorizontal: 8,
      flexDirection: 'row',
      justifyContent: 'space-around',
    },
    pickerEmoji: {
      fontSize: TYPE_SCALE.headingLarge,
      padding: 10,
    },

    // Comments section header
    commentsSectionHeader: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
    },
    commentsSectionTitle: {
      fontSize: TYPE_SCALE.body,
      fontWeight: '700',
      color: colors.text.primary,
    },

    // On-chain records section
    recordsSection: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 4,
    },
    recordsHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 6,
    },
    recordsHeader: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
      color: colors.text.secondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    recordRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      gap: 10,
    },
    recordMain: { flex: 1, minWidth: 0 },
    recordNickname: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
      color: colors.text.primary,
    },
    recordMeta: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
      marginTop: 1,
    },
    recordTxLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: RADIUS.control,
      backgroundColor: colors.background.tertiary,
    },
    recordTxLinkText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    recordEditedWarn: {
      fontSize: TYPE_SCALE.caption,
      color: colors.status.warning,
      marginBottom: 6,
    },

    // Comment rows
    commentRow: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    commentDeletedRow: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    commentHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
    },
    commentAuthorInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
    commentAuthor: { fontSize: TYPE_SCALE.caption, fontWeight: '600', color: colors.text.primary },
    commentMeta: { fontSize: TYPE_SCALE.caption, color: colors.text.tertiary },
    commentBody: { fontSize: TYPE_SCALE.body, lineHeight: 22, color: colors.text.primary },
    commentDeleted: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.tertiary, fontStyle: 'italic' },

    deleteBtn: {
      padding: 6,
    },
    deleteBtnText: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.tertiary },

    emptyComments: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
      textAlign: 'center',
      paddingVertical: 24,
      paddingHorizontal: 16,
    },

    // Reddit / Threads-style integrated comment input — single rounded pill
    // that wraps both the multiline TextInput and the inline Send button so
    // the bar reads as one keyboard accessory instead of "input + separate
    // button". Background fades into the surrounding chrome so the bar
    // visually belongs with the keyboard. paddingBottom is set dynamically
    // at render time: 0 when the keyboard is open (so the pill sits flush
    // against the keyboard top edge), insets.bottom when the keyboard is
    // closed (so the pill rests above the home indicator).
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 12,
      paddingTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border.default,
      backgroundColor: colors.background.primary,
    },
    inputPill: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      backgroundColor: colors.background.secondary,
      borderRadius: RADIUS.pill,
      paddingLeft: 16,
      paddingRight: 6,
      paddingVertical: 4,
      minHeight: 40,
    },
    input: {
      flex: 1,
      maxHeight: 120,
      paddingTop: Platform.OS === 'ios' ? 8 : 4,
      paddingBottom: Platform.OS === 'ios' ? 8 : 4,
      color: colors.text.primary,
      fontSize: TYPE_SCALE.body,
    },
    sendButton: {
      width: 32,
      height: 32,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 6,
    },
    sendButtonDisabled: { backgroundColor: colors.background.tertiary },
    sendLabel: { color: '#FFFFFF', fontSize: TYPE_SCALE.bodySmall, fontWeight: '700' },

    // Collapsed footer — single "Add comment" pill shown when the keyboard
    // is dismissed. Tapping it switches to composing mode and focuses the
    // TextInput which lives in the KeyboardStickyView so it rides above
    // the soft keyboard on both iOS and Android.
    addCommentBar: {
      paddingHorizontal: 12,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border.default,
      backgroundColor: colors.background.primary,
    },
    addCommentBtn: {
      flex: 1,
      backgroundColor: colors.background.secondary,
      borderRadius: RADIUS.pill,
      paddingHorizontal: 16,
      paddingVertical: 10,
      minHeight: 40,
      justifyContent: 'center',
    },
    addCommentText: {
      fontSize: TYPE_SCALE.body,
      color: colors.text.tertiary,
    },
  });
}

// ---------------------------------------------------------------------------
// CommentRow
// ---------------------------------------------------------------------------

function CommentRow({
  comment,
  currentUserId,
  isPlatformAdmin,
  onDelete,
  deleting,
  styles,
  colors,
}: {
  comment: Comment;
  currentUserId: string | null;
  /** True when the current user has account-level moderation powers
   *  (session.role === 'admin'). Lets admins delete any comment, not just
   *  their own. */
  isPlatformAdmin: boolean;
  onDelete: (id: string) => void;
  deleting: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  // Comment body is plain text on the server but renders through
  // PostBodyWithOg so plain-text URLs become tappable hyperlinks (via
  // autoLinkUrls inside PostContent), the first http(s) URL surfaces an
  // OG preview card, and link taps route through the in-app WebView —
  // same treatment as the post body for consistency with the rest of
  // the feed.
  // Use `any` for the navigator type — comments can be rendered from any
  // stack that surfaces a post (Feed / Topics / Profile / Chat) and they
  // all register the same `InAppBrowser` route.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation<any>();
  const openInBrowser = (url: string) => navigation.navigate('InAppBrowser', { url });
  const { t } = useTranslation();
  const isDeleted = !!comment.isDeleted || !!comment.deletedAt;

  if (isDeleted) {
    // Surface admin-driven moderation distinctly so the audience can tell a
    // moderator stepped in vs the author retracting their own comment.
    const label = comment.deletedBy === 'admin'
      ? t('openstoa.postDetail.deletedByAdmin')
      : t('openstoa.postDetail.deleted');
    return (
      <View style={styles.commentDeletedRow}>
        <Text style={styles.commentDeleted}>{label}</Text>
      </View>
    );
  }

  // Author can always remove their own comment; platform admins can remove
  // anyone's. Mirrors the web client gate (page.tsx line 518).
  const canDelete =
    !!currentUserId && (comment.authorId === currentUserId || isPlatformAdmin);

  return (
    <View style={styles.commentRow}>
      <View style={styles.commentHeader}>
        <Avatar src={null} name={comment.authorNickname} size={28} colors={colors} />
        <View style={styles.commentAuthorInfo}>
          <Text style={styles.commentAuthor}>
            {comment.authorNickname ?? truncateId(comment.authorId, 6, 4)}
            {comment.isAI ? ' 🤖' : ''}
          </Text>
          <Text style={styles.commentMeta}>
            {truncateId(comment.authorId, 6, 4)} · {formatRelativeTime(comment.createdAt)}
          </Text>
        </View>
        {canDelete && (
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => onDelete(comment.id)}
            disabled={deleting}
            activeOpacity={0.7}
          >
            <TrashIcon size={16} color={deleting ? colors.text.tertiary : colors.text.secondary} />
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.commentBody}>
        <PostBodyWithOg content={comment.content} onOpenUrl={openInBrowser} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

// Extended Post type to handle fields returned by the detail endpoint
// that are not yet in api-types (topicTitle, tags, userVoted, authorProfileImage)
interface PostDetail extends Post {
  topicTitle?: string;
  tags?: { name: string; slug: string }[];
  userVoted?: number | null;
  authorProfileImage?: string | null;
  // Whether the current user is a member of this post's topic. Used to
  // show a "Joined" badge next to the topic label so the user knows
  // which posts they can comment on without an extra join step.
  isJoinedTopic?: boolean;
}

export function PostDetailScreen() {
  const { t } = useTranslation();
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const postId: string = route.params?.postId ?? '';

  // Every outbound http(s) link in OpenStoa mobile routes through the
  // in-app WebView. See `.claude/agents/openstoa-dev.md` "External
  // links" rule.
  const openInAppBrowser = useCallback(
    (url: string, title?: string) => {
      navigation.navigate('InAppBrowser', { url, title });
    },
    [navigation],
  );
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();

  // Track keyboard visibility via the keyboard-controller hook so the
  // "Add comment" pill only renders when the keyboard is hidden, and
  // collapses back when the user dismisses the keyboard.
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  // Composing mode mirrors keyboard visibility: tapping the pill enters
  // composing mode + focuses the input (which opens the keyboard); when
  // the keyboard hides we drop back to the pill.
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (!keyboardOpen) setComposing(false);
  }, [keyboardOpen]);

  // KeyboardStickyView positions absolute relative to the screen, not the
  // tab navigator. Without offsetting by tab bar height the Add Comment
  // pill ends up BEHIND the tab bar when keyboard is closed. Negative
  // offset.closed lifts the bar by tab bar height so it sits flush above
  // the tab bar with no manual padding tweaks.
  const tabBarHeight = useBottomTabBarHeight();

  const sessionUserId = useOpenStoaSession((s) => s.userId);
  const sessionRole = useOpenStoaSession((s) => s.role);
  const isPlatformAdmin = sessionRole === 'admin';

  // Centralised post mutations — vote/bookmark/reaction/record/comment
  // all funnel through this hook, which patches every relevant query
  // cache so list views and this detail view stay in lockstep.
  const mutations = usePostMutations(postId);

  // Comment input (transient UI state only)
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Vote-in-flight latch (debounce double taps; cross-screen state lives
  // in the cache).
  const [voteLoading, setVoteLoading] = useState(false);

  // Record-in-flight latch (cross-screen state lives in the cache).
  const [recording, setRecording] = useState(false);

  // Records list — collapsed by default so it doesn't push the comments
  // section off the screen. Tap the header row to expand.
  const [recordsExpanded, setRecordsExpanded] = useState(false);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const {
    data: detail,
    isLoading: postLoading,
    error: postError,
  } = useQuery<{ post: PostDetail; comments: Comment[] }>({
    queryKey: ['post', postId],
    queryFn: () =>
      client.get<{ post: PostDetail; comments: Comment[] }>(`/api/posts/${postId}`),
    enabled: !!postId,
  });

  const post = detail?.post as PostDetail | undefined;
  const commentList = detail?.comments ?? [];

  // Bookmark state lives in its own cache key because the dedicated
  // GET endpoint is the source of truth on first entry. After that,
  // toggleBookmark mirrors the value into `userBookmarked` on the
  // post-detail cache so other surfaces (PostCard etc.) stay in sync.
  const { data: bookmarkData } = useQuery<{ bookmarked: boolean }>({
    queryKey: ['bookmark', postId],
    queryFn: () =>
      client.get<{ bookmarked: boolean }>(`/api/posts/${postId}/bookmark`),
    enabled: !!postId,
  });

  // Everything below is derived from the React Query cache. No local
  // mirroring — that's what kept causing the "tap, flash, revert" desync
  // (props/cache updated, useState didn't).
  const userVote = (post?.userVoted ?? null) as 1 | -1 | null;
  const upvoteCount = post?.upvoteCount ?? 0;
  const bookmarked =
    bookmarkData?.bookmarked ?? !!(post as { userBookmarked?: boolean } | undefined)?.userBookmarked;
  const recorded = !!(post as { userRecorded?: boolean } | undefined)?.userRecorded;
  const recordCount = (post as { recordCount?: number } | undefined)?.recordCount ?? 0;

  // Fetch reactions. The data lives in the query cache directly; we
  // read it via `reactionsData?.reactions ?? []` everywhere below so
  // re-entry into this screen picks up whatever the cache currently
  // holds (including the value we wrote via setQueryData on the
  // previous toggle).
  const { data: reactionsData } = useQuery<{ reactions: Reaction[] }>({
    queryKey: ['reactions', postId],
    queryFn: async () =>
      client.get<{ reactions: Reaction[] }>(`/api/posts/${postId}/reactions`),
    enabled: !!postId,
  });
  const reactions: Reaction[] = reactionsData?.reactions ?? [];

  // On-chain record receipts. Each entry has a Base transaction hash
  // we expose as a tappable "view on BaseScan" link so users can
  // verify the recording themselves. Refetches when the post's record
  // count changes (e.g. after handleRecord finishes).
  interface RecordRow {
    id: string;
    recorderNickname: string | null;
    recorderProfileImage: string | null;
    txHash: string | null;
    contentHash: string;
    contentHashMatch: boolean;
    createdAt: string;
  }
  const { data: recordsData } = useQuery<{
    records: RecordRow[];
    recordCount: number;
    postEdited: boolean;
  }>({
    queryKey: ['post-records', postId, recordCount],
    queryFn: () =>
      client.get<{
        records: RecordRow[];
        recordCount: number;
        postEdited: boolean;
      }>(`/api/posts/${postId}/records`),
    enabled: !!postId && recordCount > 0,
  });
  const recordRows: RecordRow[] = recordsData?.records ?? [];

  // Topic-level role for the current user (owner / admin / member /
  // null=non-member). Used for moderation affordances scoped to the
  // post's parent topic — primarily the Pin/Unpin action. Mirrors the
  // shape from openstoa/src/app/api/topics/[topicId]/route.ts:187-196.
  // Reuses the same ['topic', topicId] query key TopicDetailScreen
  // already populates so re-entering the screen pulls from cache instead
  // of refetching.
  const { data: topicMeta } = useQuery<{
    topic: { isMember?: boolean } | null;
    currentUserRole?: 'owner' | 'admin' | 'member' | null;
  }>({
    queryKey: ['topic', post?.topicId],
    queryFn: () =>
      client.get<{
        topic: { isMember?: boolean } | null;
        currentUserRole?: 'owner' | 'admin' | 'member' | null;
      }>(`/api/topics/${post?.topicId}`),
    enabled: !!post?.topicId && !!sessionUserId,
    staleTime: 30 * 1000,
  });
  const topicRole = topicMeta?.currentUserRole ?? null;
  const isTopicOwnerOrAdmin = topicRole === 'owner' || topicRole === 'admin';
  const isPinned = !!post?.isPinned;

  // Eligibility check — driven off the same server policy as the POST
  // endpoint, surfaced BEFORE the user taps so we can disable the
  // button + annotate the reason. Previously the only way the user
  // learned they were rate-limited was after confirming the prompt,
  // hitting POST, and getting a raw 403.
  const { data: recordStatus } = useQuery<{
    allowed: boolean;
    reason: string | null;
  }>({
    queryKey: ['record-status', postId],
    queryFn: () =>
      client.get<{ allowed: boolean; reason: string | null }>(
        `/api/posts/${postId}/record-status`,
      ),
    enabled: !!postId && !!sessionUserId && !!post && post.authorId !== sessionUserId,
    staleTime: 30 * 1000,
  });

  // Translate the server's English `reason` string into a user-friendly
  // localised message. Falls back to the raw string for anything we
  // didn't anticipate — better than the previous "POST /api/... → 403"
  // dump.
  function localiseRecordReason(reason: string | null | undefined): string | null {
    if (!reason) return null;
    if (/Cannot record your own post/i.test(reason)) {
      return t('openstoa.postDetail.recordReason.ownPost');
    }
    if (/already recorded this post/i.test(reason)) {
      return t('openstoa.postDetail.recordReason.alreadyRecorded');
    }
    const m = reason.match(/Daily record limit reached \((\d+)\/day\)/);
    if (m) {
      return t('openstoa.postDetail.recordReason.dailyLimit', { limit: m[1] });
    }
    const m2 = reason.match(/Post must be at least 1 hour old\.\s*(\d+) minutes remaining/);
    if (m2) {
      return t('openstoa.postDetail.recordReason.tooNew', { minutes: m2[1] });
    }
    return reason;
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  // Auto-replay handlers — guests see the SignInSheet on tap; authed users
  // fire immediately; the action auto-runs after sign-in via the gate.
  const handleVote = useAuthGuardedAction(async (value: 1 | -1) => {
    if (voteLoading) return;
    setVoteLoading(true);
    try {
      await mutations.vote(value, { userVoted: userVote, upvoteCount });
    } finally {
      setVoteLoading(false);
    }
  });

  const handleBookmark = useAuthGuardedAction(() => {
    void mutations.toggleBookmark(bookmarked);
    // Also patch the dedicated ['bookmark', postId] cache the GET
    // endpoint backs so the next remount doesn't read a stale value.
    queryClient.setQueryData<{ bookmarked: boolean }>(
      ['bookmark', postId],
      { bookmarked: !bookmarked },
    );
  });

  const handleShare = useCallback(async () => {
    // Mirrors web `navigator.share`: open the OS-native share sheet so
    // the user picks Copy / Messages / AirDrop / etc. Previously this
    // copied the URL straight to clipboard with no feedback differentiation
    // from a normal tap.
    const url = `${client.getBaseUrl()}/topics/${post?.topicId ?? ''}/posts/${postId}`;
    try {
      await Share.share({ message: url, url, title: post?.title ?? 'OpenStoa post' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Share failed', msg);
    }
  }, [client, post?.topicId, post?.title, postId]);

  const handleRecord = useAuthGuardedAction(() => {
    if (recording || recorded) return;
    // Pre-flight: if the server already says we can't record, surface
    // a friendly localised reason instead of confirming → POST → 403.
    if (recordStatus && !recordStatus.allowed) {
      Alert.alert(
        t('openstoa.postDetail.recordBlockedTitle'),
        localiseRecordReason(recordStatus.reason) ?? '',
      );
      return;
    }
    Alert.alert(
      t('openstoa.postDetail.recordConfirmTitle'),
      t('openstoa.postDetail.recordConfirmMessage'),
      [
        { text: t('openstoa.common.cancel'), style: 'cancel' },
        {
          text: t('openstoa.postDetail.recordConfirmOk'),
          style: 'default',
          onPress: async () => {
            setRecording(true);
            try {
              await mutations.record({ recorded, recordCount });
              // Force a fresh status read so the button reflects the
              // new state (now in 'already recorded' territory).
              void queryClient.invalidateQueries({ queryKey: ['record-status', postId] });
            } catch (e) {
              // Try to peel the server's `{"error":"…"}` body out of
              // openstoaClient's raw "<METHOD> <PATH> → <STATUS>: <BODY>"
              // format so the user sees the real reason, then run it
              // through the same localisation table.
              const raw = e instanceof Error ? e.message : String(e);
              let reason = raw;
              const idx = raw.lastIndexOf(': ');
              if (idx > -1) {
                const tail = raw.slice(idx + 2).trim();
                try {
                  const parsed = JSON.parse(tail) as { error?: string };
                  if (parsed.error) reason = parsed.error;
                } catch { /* leave raw */ }
              }
              Alert.alert(
                t('openstoa.postDetail.recordFailedTitle'),
                localiseRecordReason(reason) ?? reason,
              );
              void queryClient.invalidateQueries({ queryKey: ['record-status', postId] });
            } finally {
              setRecording(false);
            }
          },
        },
      ],
    );
  });

  const handleReaction = useAuthGuardedAction((emoji: string) => {
    void mutations.toggleReaction(emoji, reactions);
  });

  // Tapping the "+" reaction picker on a public post: for guests we still
  // want the SignInSheet first; once signed in the picker opens
  // automatically via the gate's replay path.
  const openReactionPicker = useAuthGuardedAction(() =>
    setShowEmojiPicker(true),
  );

  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (deletingCommentId) return;
    setDeletingCommentId(commentId);
    try {
      await client.delete(`/api/comments/${commentId}`);
      queryClient.setQueryData(
        ['post', postId],
        (old: { post: PostDetail; comments: Comment[] } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            comments: old.comments.map((c) =>
              c.id === commentId ? { ...c, isDeleted: true, content: '' } : c,
            ),
          };
        },
      );
    } catch {
      // silent
    } finally {
      setDeletingCommentId(null);
    }
  }, [client, postId, queryClient, deletingCommentId]);

  const handleSendComment = useAuthGuardedAction(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    const result = await mutations.addComment(text);
    setSending(false);
    if (!result.ok) {
      setDraft(text);
      if (result.reason === 'not_member') {
        Alert.alert(
          t('openstoa.postDetail.commentJoinRequiredTitle'),
          t('openstoa.postDetail.commentJoinRequiredMessage'),
        );
      } else {
        Alert.alert(
          t('openstoa.postDetail.commentSendFailedTitle'),
          result.message ?? '',
        );
      }
    } else {
      // Success — collapse footer + dismiss keyboard so the user sees
      // their new comment land in the list.
      Keyboard.dismiss();
      setComposing(false);
    }
  });

  // Enter composing mode + focus. Focus runs in a useEffect after the
  // TextInput actually mounts (it's conditionally rendered when composing
  // flips true), otherwise inputRef.current is null and the keyboard
  // never opens — the recurring "Add Comment doesn't respond" regression.
  const beginComposing = useCallback(() => {
    setComposing(true);
  }, []);
  useEffect(() => {
    if (composing) {
      // Defer one frame so the conditional render mounts the TextInput
      // before focus() runs.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [composing]);

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (postLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  const isAuthor = !!(sessionUserId && post && sessionUserId === post.authorId);

  if (postError || !post) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          {postError ? (postError as Error).message : t('openstoa.postDetail.notFound')}
        </Text>
      </View>
    );
  }

  // Combined kebab menu — surfaces author actions (edit/delete), topic-owner
  // moderation (pin/unpin), and platform admin moderation (delete any post).
  // Visibility rules per row:
  //   - Edit/Edit-locked: author only.
  //   - Pin/Unpin: topic owner OR topic admin (any post).
  //   - Delete: author OR platform admin (account-level moderation).
  // Uses ActionSheetIOS on iOS and a stacked Alert on Android to stay
  // native-feeling without pulling in an extra modal lib.
  const canEdit = isAuthor && recordCount === 0;
  const canPin = isTopicOwnerOrAdmin;
  const canDelete = isAuthor || isPlatformAdmin;
  const postTopicId = post.topicId;
  const postTopicTitle = post.topicTitle;
  const openAuthorMenu = () => {
    const options: string[] = [];
    const handlers: (() => void)[] = [];
    if (canEdit) {
      options.push(t('openstoa.postDetail.editPost'));
      handlers.push(() =>
        (navigation as unknown as { navigate: (n: string, p: object) => void }).navigate(
          'PostCreate',
          { topicId: postTopicId, topicTitle: postTopicTitle, editPostId: postId },
        ),
      );
    } else if (isAuthor && recordCount > 0) {
      options.push(t('openstoa.postDetail.editLocked'));
      handlers.push(() =>
        Alert.alert(
          t('openstoa.postDetail.editLockedTitle'),
          t('openstoa.postDetail.editLockedMessage'),
        ),
      );
    }
    if (canPin) {
      options.push(
        isPinned
          ? t('openstoa.postDetail.unpinPost')
          : t('openstoa.postDetail.pinPost'),
      );
      handlers.push(async () => {
        const res = await mutations.togglePin(isPinned);
        if (!res.ok) {
          Alert.alert(t('openstoa.postDetail.pinFailed'), res.message ?? '');
        }
      });
    }
    if (canDelete) {
      options.push(t('openstoa.postDetail.deletePost'));
      handlers.push(() => {
        Alert.alert(
          t('openstoa.postDetail.deleteConfirmTitle'),
          t('openstoa.postDetail.deleteConfirmMessage'),
          [
            { text: t('openstoa.common.cancel'), style: 'cancel' },
            {
              text: t('openstoa.postDetail.deletePost'),
              style: 'destructive',
              onPress: async () => {
                try {
                  await client.delete(`/api/posts/${postId}`);
                  queryClient.invalidateQueries({ queryKey: ['feed'] });
                  queryClient.invalidateQueries({ queryKey: ['topic', postTopicId, 'posts'] });
                  navigation.goBack();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  Alert.alert(t('openstoa.postDetail.deleteFailed'), msg);
                }
              },
            },
          ],
        );
      });
    }
    if (options.length === 0) return;
    const cancelLabel = t('openstoa.common.cancel');
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [cancelLabel, ...options],
          cancelButtonIndex: 0,
          // Last entry is delete iff canDelete is true (we always push it last).
          destructiveButtonIndex: canDelete ? options.length : undefined,
        },
        (i) => {
          if (i === 0) return;
          handlers[i - 1]?.();
        },
      );
    } else {
      Alert.alert(t('openstoa.postDetail.postActions'), undefined, [
        ...options.map((label, i) => ({ text: label, onPress: handlers[i] })),
        { text: cancelLabel, style: 'cancel' as const },
      ]);
    }
  };

  // ---------------------------------------------------------------------------
  // FlatList header = full post body
  // ---------------------------------------------------------------------------

  // Unified video list: structured `post.media.videos` first, then any
  // YouTube/Vimeo URLs still hiding inside legacy HTML content. Deduped by
  // (type, videoId).
  const videoItems = (() => {
    const items: { type: 'youtube' | 'vimeo'; src: string }[] = [];
    for (const url of post.media?.videos ?? []) {
      const yt =
        /(?:youtube\.com\/watch\?[^\s]*v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/.exec(url);
      if (yt) {
        items.push({ type: 'youtube', src: yt[1] });
        continue;
      }
      const vm = /vimeo\.com\/(\d+)/.exec(url);
      if (vm) {
        items.push({ type: 'vimeo', src: vm[1] });
      }
    }
    const fromContent = extractMediaItems(post.content ?? '').filter(
      (m): m is { type: 'youtube' | 'vimeo'; src: string; thumbnail: string } =>
        m.type === 'youtube' || m.type === 'vimeo',
    );
    for (const m of fromContent) items.push({ type: m.type, src: m.src });
    const seen = new Set<string>();
    return items.filter((v) => {
      const k = `${v.type}:${v.src}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })();

  const ListHeader = (
    <View>
      {/* ── Post header: topic label + author avatar + name + meta ── */}
      <View style={styles.postHeader}>
        {post.topicTitle ? (
          <View style={styles.topicRow}>
            <Text style={styles.topicLabel}>{post.topicTitle}</Text>
            {post.isJoinedTopic ? (
              <View style={styles.joinedBadge}>
                <Text style={styles.joinedBadgeText}>{t('openstoa.topics.joinedBadge')}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <View style={styles.authorRow}>
          <Avatar src={post.authorProfileImage} name={post.authorNickname} size={36} colors={colors} />
          <View style={styles.authorInfo}>
            <Text style={styles.authorName}>
              {post.authorNickname ?? truncateId(post.authorId, 6, 4)}
              {post.isAI ? ' 🤖' : ''}
            </Text>
            <Text style={styles.authorMeta}>
              {truncateId(post.authorId, 6, 4)} · {formatRelativeTime(post.createdAt)}
            </Text>
          </View>
          {/* Kebab menu — surfaces author edit/delete, topic-owner pin/unpin,
              and platform-admin moderation. Hidden when the current user
              has no available actions on this post. */}
          {(isAuthor || isTopicOwnerOrAdmin || isPlatformAdmin) ? (
            <TouchableOpacity
              style={styles.headerKebab}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={openAuthorMenu}
            >
              <Text style={styles.headerKebabGlyph}>⋯</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* ── Title ── Pinned posts get a small purple thumbtack icon
              (MaterialCommunityIcons 'pin' — Feather's map-pin is a GPS
              marker, wrong shape). */}
      <View style={styles.postTitleRow}>
        {isPinned ? (
          <MaterialCommunityIcons
            name="pin"
            size={18}
            color={colors.brand.primary}
            style={styles.postTitlePinIcon}
          />
        ) : null}
        <Text style={styles.postTitle}>{post.title}</Text>
      </View>

      {/* ── Tags ── */}
      {post.tags && post.tags.length > 0 ? (
        <View style={styles.tagsRow}>
          {post.tags.map((tag) => (
            <View key={tag.slug} style={styles.tag}>
              <Text style={styles.tagText}>{tag.name}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Body (video URLs stripped from legacy posts; inline images
              rendered by PostContent for back-compat) ── */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <PostBodyWithOg
          content={stripVideoUrls(post.content ?? '')}
          onOpenUrl={(url) => navigation.navigate('InAppBrowser', { url })}
        />
      </View>

      {/* ── Unified media block — swipeable image carousel + every video
              card inline. Reads `post.media.{images,videos}` first;
              legacy URLs hiding inside `content` are unioned in via the
              videoItems extraction above. Detail mode plays every video,
              the feed card only plays the first. ── */}
      <View style={{ paddingHorizontal: 16 }}>
        <MediaGallery
          // Union explicit `post.media.images` with any legacy `<img>` tags
          // still buried inside `content`. The gallery always renders so
          // even legacy posts get a swipeable preview. PostContent renders
          // its own inline copy above — that intentional duplication is
          // what the user wants. (Randomized placeholder hosts like
          // picsum.photos will return two different images for the same
          // URL; real R2 URLs are stable.)
          images={(() => {
            const fromMedia = post.media?.images ?? [];
            const fromContent = extractMediaItems(post.content ?? '')
              .filter((m) => m.type === 'image')
              .map((m) => m.src);
            const seen = new Set<string>();
            return [...fromMedia, ...fromContent].filter((u) => {
              if (seen.has(u)) return false;
              seen.add(u);
              return true;
            });
          })()}
          videos={videoItems.map((v) =>
            v.type === 'youtube'
              ? `https://youtu.be/${v.src}`
              : `https://vimeo.com/${v.src}`,
          )}
          mode="detail"
          horizontalPadding={32}
        />
      </View>

      {/* ── Poll ── */}
      {post.poll ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <PollRenderer postId={post.id} poll={post.poll} />
        </View>
      ) : null}

      {/* ── Action bar ── */}
      <View style={styles.actionBar}>
        {/* Up/down vote pill */}
        <View style={styles.votePill}>
          <TouchableOpacity
            style={styles.votePillBtn}
            activeOpacity={0.7}
            onPress={() => handleVote(1)}
            disabled={voteLoading}
            hitSlop={8}
          >
            <ArrowUpIcon size={18} filled={userVote === 1} color={colors.text.tertiary} />
          </TouchableOpacity>
          <Text
            style={
              userVote === 1
                ? [styles.votePillCountActive, { color: '#22c55e' }]
                : userVote === -1
                ? [styles.votePillCountActive, { color: '#3b82f6' }]
                : styles.votePillCount
            }
          >
            {upvoteCount}
          </Text>
          <TouchableOpacity
            style={styles.votePillBtn}
            activeOpacity={0.7}
            onPress={() => handleVote(-1)}
            disabled={voteLoading}
            hitSlop={8}
          >
            <ArrowDownIcon size={18} filled={userVote === -1} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>

        {/* Comment count — tapping enters composing mode + focuses input */}
        <TouchableOpacity
          style={styles.actionBtn}
          activeOpacity={0.7}
          onPress={beginComposing}
        >
          <CommentIcon size={20} color={colors.text.tertiary} />
          {commentList.length > 0 ? (
            <Text style={styles.actionCount}>{commentList.length}</Text>
          ) : null}
        </TouchableOpacity>

        {/* View count */}
        {post.viewCount > 0 ? (
          <View style={styles.actionBtn}>
            <EyeIcon size={18} color={colors.text.tertiary} />
            <Text style={styles.actionCount}>{post.viewCount}</Text>
          </View>
        ) : null}

        {/* Share — opens the OS-native share sheet */}
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={handleShare}>
          <ShareIcon size={18} color={colors.text.tertiary} />
        </TouchableOpacity>

        {/* Record on-chain — hidden for post author only. Guests see the
            button but tapping it surfaces the SignInSheet via handleRecord
            instead of being silently disabled. Layout matches the PostCard
            variant: anchor icon coloured purple when the current user has
            recorded, with the running count always visible. */}
        {!isAuthor ? (
          (() => {
            const policyBlocked = !!(recordStatus && !recordStatus.allowed);
            const tint = recorded ? '#8b5cf6' : colors.text.tertiary;
            return (
              <TouchableOpacity
                style={[styles.actionBtn, policyBlocked ? { opacity: 0.5 } : null]}
                activeOpacity={recorded ? 1 : 0.7}
                onPress={handleRecord}
                disabled={recording}
                accessibilityHint={
                  policyBlocked
                    ? localiseRecordReason(recordStatus?.reason) ?? undefined
                    : undefined
                }
              >
                <RecordIcon size={18} color={tint} />
                {recording ? (
                  <Text style={[styles.actionCountActive, { color: '#8b5cf6' }]}>…</Text>
                ) : (
                  <Text
                    style={
                      recorded
                        ? [styles.actionCountActive, { color: '#8b5cf6' }]
                        : styles.actionCount
                    }
                  >
                    {recordCount}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })()
        ) : null}

        <View style={styles.actionSpacer} />

        {/* Bookmark — visible to guests too; tap triggers SignInSheet via
            handleBookmark for users without an authenticated session. */}
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={handleBookmark}>
          <BookmarkIcon size={20} filled={bookmarked} color={colors.text.tertiary} filledColor={colors.brand.primary} />
        </TouchableOpacity>
      </View>

      {/* ── Emoji reactions ── always shown; guest taps surface SignInSheet. */}
      <View style={styles.reactionsRow}>
        {reactions
          .filter((r) => r.count > 0)
          .map((r) => (
            <TouchableOpacity
              key={r.emoji}
              style={[
                styles.reactionPill,
                r.userReacted ? styles.reactionPillActive : styles.reactionPillInactive,
              ]}
              activeOpacity={0.7}
              onPress={() => handleReaction(r.emoji)}
            >
              <Text style={styles.reactionEmoji}>{r.emoji}</Text>
              <Text style={r.userReacted ? styles.reactionCountActive : styles.reactionCount}>
                {r.count}
              </Text>
            </TouchableOpacity>
          ))}
        <TouchableOpacity
          style={styles.addReactionBtn}
          activeOpacity={0.7}
          onPress={openReactionPicker}
        >
          <Text style={styles.addReactionText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* ── On-chain record receipts (collapsible) ── */}
      {recordCount > 0 ? (
        <View style={styles.recordsSection}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setRecordsExpanded((v) => !v)}
            style={styles.recordsHeaderRow}
            accessibilityRole="button"
            accessibilityLabel={t('openstoa.postDetail.recordsHeader', { count: recordCount })}
          >
            <Text style={styles.recordsHeader}>
              {t('openstoa.postDetail.recordsHeader', { count: recordCount })}
            </Text>
            <Feather
              name={recordsExpanded ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.text.tertiary}
            />
          </TouchableOpacity>
          {recordsExpanded && recordsData?.postEdited ? (
            <Text style={styles.recordEditedWarn}>
              {t('openstoa.postDetail.recordPostEdited')}
            </Text>
          ) : null}
          {recordsExpanded
            ? recordRows.map((r) => {
                // Explorer URL is set by the server based on the active
                // chain (Base Mainnet vs Sepolia). No fallback — falling
                // back to a hardcoded sepolia URL when the server omits
                // the field would mislead users on production where the
                // tx lives on Base Mainnet (ABSOLUTE RULE: no hardcoded
                // env fallbacks). When the field is null/undefined we
                // render a "pending…" label until the indexer fills it.
                const url = (r as RecordRow & { txExplorerUrl?: string | null }).txExplorerUrl
                  ?? null;
                return (
                  <View key={r.id} style={styles.recordRow}>
                    <Avatar
                      src={r.recorderProfileImage}
                      name={r.recorderNickname}
                      size={28}
                      colors={colors}
                    />
                    <View style={styles.recordMain}>
                      <Text style={styles.recordNickname} numberOfLines={1}>
                        {r.recorderNickname ?? t('openstoa.postCard.author.anon')}
                      </Text>
                      <Text style={styles.recordMeta}>
                        {formatRelativeTime(r.createdAt)}
                        {r.contentHashMatch ? '' : ` · ${t('openstoa.postDetail.recordContentMismatch')}`}
                      </Text>
                    </View>
                    {url ? (
                      <TouchableOpacity
                        activeOpacity={0.7}
                        style={styles.recordTxLink}
                        onPress={() => openInAppBrowser(url, t('openstoa.postDetail.viewOnBase'))}
                      >
                        <Text style={styles.recordTxLinkText}>
                          {t('openstoa.postDetail.viewOnBase')}
                        </Text>
                        <Feather name="external-link" size={11} color={colors.brand.primary} />
                      </TouchableOpacity>
                    ) : (
                      <Text style={styles.recordMeta}>
                        {t('openstoa.postDetail.recordPending')}
                      </Text>
                    )}
                  </View>
                );
              })
            : null}
        </View>
      ) : null}

      {/* ── Comments section header ── */}
      <View style={styles.commentsSectionHeader}>
        <Text style={styles.commentsSectionTitle}>
          {commentList.length > 0
            ? `${commentList.length} Comment${commentList.length !== 1 ? 's' : ''}`
            : t('openstoa.postDetail.commentsHeader', { count: 0 }).replace(' (0)', '')}
        </Text>
      </View>
    </View>
  );

  // The actual input pill (TextInput + Send button) — lives inside the
  // KeyboardStickyView at the root so it always floats above the soft
  // keyboard on both iOS and Android.
  const renderInputPill = () => (
    <View
      style={[
        styles.inputRow,
        { paddingBottom: keyboardOpen ? 6 : Math.max(insets.bottom, 8) },
      ]}
    >
      <View style={styles.inputPill}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={t('openstoa.postDetail.addCommentPlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={draft}
          onChangeText={setDraft}
          editable={!sending}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, (!draft.trim() || sending) && styles.sendButtonDisabled]}
          onPress={handleSendComment}
          disabled={!draft.trim() || sending}
          activeOpacity={0.8}
          accessibilityLabel={t('openstoa.postDetail.send')}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Feather name="arrow-up" size={18} color="#FFFFFF" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  // Collapsed footer — a single "Add comment" pill. Tapping it switches
  // to composing mode + opens the keyboard. The bottom tab bar below
  // already adds its own safe-area inset, so the pill only needs a
  // small base padding to sit flush above the tab bar — adding
  // `insets.bottom` here doubled the safe-area space and left a gap.
  const renderAddCommentBar = () => (
    <View
      // Always pad by safe-area insets.bottom — this bar only renders when
      // composing=false (which only happens when the keyboard is closed),
      // so a `keyboardOpen ? 6 : insets` ternary creates a 28pt jump at the
      // exact moment composing flips false on keyboard dismiss. Using a
      // constant value here keeps the transition smooth.
      style={[styles.addCommentBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
    >
      <TouchableOpacity
        style={styles.addCommentBtn}
        activeOpacity={0.7}
        onPress={beginComposing}
        accessibilityRole="button"
        accessibilityLabel={t('openstoa.postDetail.addCommentPlaceholder')}
      >
        <Text style={styles.addCommentText}>
          {t('openstoa.postDetail.addCommentPlaceholder')}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlatList
        data={commentList}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            currentUserId={sessionUserId}
            isPlatformAdmin={isPlatformAdmin}
            onDelete={handleDeleteComment}
            deleting={deletingCommentId === item.id}
            styles={styles}
            colors={colors}
          />
        )}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={
          <Text style={styles.emptyComments}>{t('openstoa.postDetail.noComments')}</Text>
        }
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      />
      {/* offset.closed = tabBarHeight: PostDetail lives inside the bottom-tab
          navigator, so y=0 from the screen bottom is occupied by the tab
          bar (~83px on iPhone). Without this offset the pill is hidden
          behind the tab bar and onPress hits never reach it (= "tap does
          nothing, keyboard never opens"). PostCreate uses closed:0 because
          it's a stack-modal route with no tab bar underneath. */}
      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        {composing ? renderInputPill() : renderAddCommentBar()}
      </KeyboardStickyView>

      {/* Emoji picker bottom sheet */}
      <Modal
        visible={showEmojiPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowEmojiPicker(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowEmojiPicker(false)}
        >
          <View style={styles.pickerSheet}>
            {REACTION_EMOJIS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                onPress={() => {
                  handleReaction(emoji);
                  setShowEmojiPicker(false);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.pickerEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

