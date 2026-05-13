import React, { useState, useCallback, useRef } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Post, Comment } from '@openstoa/api-types';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { usePostMutations } from '../../hooks/usePostMutations';
import { MediaGallery } from '../../components/MediaGallery';
import { PollRenderer } from '../../components/PollRenderer';
import { PostContent, extractMediaItems, stripVideoUrls } from '../../components/PostContent';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, RecordIcon, TrashIcon } from '../../components/icons';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';

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
  if (src) {
    return (
      <Image
        source={{ uri: src }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="cover"
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
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
    errorText: { fontSize: 14, color: colors.status.danger, textAlign: 'center' },
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
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    joinedBadge: {
      backgroundColor: colors.status.success + '22',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    joinedBadgeText: {
      fontSize: 10,
      fontWeight: '600',
      color: colors.status.success,
    },
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    authorInfo: { flex: 1 },
    authorName: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
    authorMeta: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
    headerKebab: { paddingHorizontal: 8, paddingVertical: 4 },
    headerKebabGlyph: { fontSize: 20, color: colors.text.tertiary, lineHeight: 22 },

    // Title
    postTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text.primary,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
      lineHeight: 30,
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
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    tagText: {
      fontSize: 12,
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
    actionIcon: { fontSize: 14, color: colors.text.tertiary },
    actionIconActive: { fontSize: 14 },
    actionCount: { fontSize: 12, color: colors.text.tertiary },
    actionCountActive: { fontSize: 12 },
    actionSpacer: { flex: 1 },
    votePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 18,
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    votePillBtn: {
      paddingHorizontal: 3,
      paddingVertical: 2,
    },
    votePillCount: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text.secondary,
      minWidth: 14,
      textAlign: 'center',
    },
    votePillCountActive: {
      fontSize: 14,
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
      borderRadius: 999,
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
    reactionEmoji: { fontSize: 14 },
    reactionCount: { fontSize: 12, color: colors.text.tertiary },
    reactionCountActive: { fontSize: 12, color: colors.brand.primary, fontWeight: '600' },
    addReactionBtn: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    addReactionText: { fontSize: 14, color: colors.text.tertiary },

    // Emoji picker modal
    pickerOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'flex-end',
    },
    pickerSheet: {
      backgroundColor: colors.background.secondary,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 8,
      flexDirection: 'row',
      justifyContent: 'space-around',
    },
    pickerEmoji: {
      fontSize: 28,
      padding: 10,
    },

    // Comments section header
    commentsSectionHeader: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
    },
    commentsSectionTitle: {
      fontSize: 15,
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
      fontSize: 13,
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
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.primary,
    },
    recordMeta: {
      fontSize: 11,
      color: colors.text.tertiary,
      marginTop: 1,
    },
    recordTxLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: colors.background.tertiary,
    },
    recordTxLinkText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    recordEditedWarn: {
      fontSize: 11,
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
    commentAuthor: { fontSize: 13, fontWeight: '600', color: colors.text.primary },
    commentMeta: { fontSize: 11, color: colors.text.tertiary },
    commentBody: { fontSize: 15, lineHeight: 22, color: colors.text.primary },
    commentDeleted: { fontSize: 14, color: colors.text.tertiary, fontStyle: 'italic' },

    deleteBtn: {
      padding: 6,
    },
    deleteBtnText: { fontSize: 14, color: colors.text.tertiary },

    emptyComments: {
      fontSize: 14,
      color: colors.text.tertiary,
      textAlign: 'center',
      paddingVertical: 24,
      paddingHorizontal: 16,
    },

    // Bottom input
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      padding: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 8,
      color: colors.text.primary,
      backgroundColor: colors.background.primary,
    },
    sendButton: {
      marginLeft: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 18,
      backgroundColor: colors.brand.primary,
      minWidth: 60,
      alignItems: 'center',
    },
    sendButtonDisabled: { backgroundColor: colors.border.strong },
    sendLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  });
}

// ---------------------------------------------------------------------------
// CommentRow
// ---------------------------------------------------------------------------

function CommentRow({
  comment,
  currentUserId,
  onDelete,
  deleting,
  styles,
  colors,
}: {
  comment: Comment;
  currentUserId: string | null;
  onDelete: (id: string) => void;
  deleting: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}) {
  const { t } = useTranslation();
  const isDeleted = !!comment.isDeleted || !!comment.deletedAt;

  if (isDeleted) {
    return (
      <View style={styles.commentDeletedRow}>
        <Text style={styles.commentDeleted}>
          {t('openstoa.postDetail.deleted')}
        </Text>
      </View>
    );
  }

  const canDelete = !!(currentUserId && comment.authorId === currentUserId);

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
      <Text style={styles.commentBody}>{comment.content}</Text>
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

  const sessionUserId = useOpenStoaSession((s) => s.userId);

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

  const handleVote = useCallback(
    async (value: 1 | -1) => {
      if (voteLoading || !sessionUserId) return;
      setVoteLoading(true);
      try {
        await mutations.vote(value, { userVoted: userVote, upvoteCount });
      } finally {
        setVoteLoading(false);
      }
    },
    [mutations, userVote, upvoteCount, voteLoading, sessionUserId],
  );

  const handleBookmark = useCallback(() => {
    if (!sessionUserId) return;
    void mutations.toggleBookmark(bookmarked);
    // Also patch the dedicated ['bookmark', postId] cache the GET
    // endpoint backs so the next remount doesn't read a stale value.
    queryClient.setQueryData<{ bookmarked: boolean }>(
      ['bookmark', postId],
      { bookmarked: !bookmarked },
    );
  }, [mutations, bookmarked, sessionUserId, queryClient, postId]);

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

  const handleRecord = useCallback(() => {
    if (recording || recorded || !sessionUserId) return;
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
  }, [mutations, recording, recorded, recordCount, sessionUserId, t, recordStatus, queryClient, postId]);

  const handleReaction = useCallback(
    (emoji: string) => {
      if (!sessionUserId) return;
      void mutations.toggleReaction(emoji, reactions);
    },
    [mutations, reactions, sessionUserId],
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

  const handleSendComment = useCallback(async () => {
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
    }
  }, [draft, sending, mutations, t]);

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

  const isGuest = !sessionUserId;
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

  // Author-only kebab menu: edit (locked once the post is on-chain) +
  // soft delete. Uses ActionSheetIOS on iOS and a stacked Alert on
  // Android to stay native-feeling without pulling in an extra modal lib.
  // NOTE: `post` is non-null below this line — the early return above
  // already guarded against undefined. We snapshot the fields we need so
  // the handler doesn't dereference `post` directly (TS narrowing inside
  // a closure was getting noisy after the early-return refactor).
  const canEdit = isAuthor && recordCount === 0;
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
    const cancelLabel = t('openstoa.common.cancel');
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [cancelLabel, ...options],
          cancelButtonIndex: 0,
          destructiveButtonIndex: options.length, // last item = delete
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
          {/* Author-only overflow menu — edit (locked once the post is
              recorded on-chain) + delete. Hidden for non-authors. */}
          {isAuthor ? (
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

      {/* ── Title ── */}
      <Text style={styles.postTitle}>{post.title}</Text>

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
        <PostContent content={stripVideoUrls(post.content ?? '')} omitImages />
      </View>

      {/* ── Unified media block — swipeable image carousel + every video
              card inline. Reads `post.media.{images,videos}` first;
              legacy URLs hiding inside `content` are unioned in via the
              videoItems extraction above. Detail mode plays every video,
              the feed card only plays the first. ── */}
      <View style={{ paddingHorizontal: 16 }}>
        <MediaGallery
          // Union explicit `post.media.images` with any legacy `<img>` tags
          // still buried inside `content`. Old posts only carry images via
          // the HTML body; new posts carry them in `media.images`. Dedupe
          // by URL so a post migrated mid-flight doesn't double-render.
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
            disabled={isGuest || voteLoading}
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
            disabled={isGuest || voteLoading}
            hitSlop={8}
          >
            <ArrowDownIcon size={18} filled={userVote === -1} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>

        {/* Comment count — tapping focuses the input */}
        <TouchableOpacity
          style={styles.actionBtn}
          activeOpacity={0.7}
          onPress={() => inputRef.current?.focus()}
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

        {/* Record on-chain — hidden for post author and guests. Layout
            matches the PostCard variant: anchor icon coloured purple
            when the current user has recorded, with the running count
            always visible. No more "✓ swallows the count" trick. */}
        {sessionUserId && !isAuthor ? (
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

        {/* Bookmark — hidden for guests */}
        {!isGuest ? (
          <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={handleBookmark}>
            <BookmarkIcon size={20} filled={bookmarked} color={colors.text.tertiary} filledColor={colors.brand.primary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Emoji reactions ── */}
      {(reactions.filter((r) => r.count > 0).length > 0 || !isGuest) ? (
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
                activeOpacity={isGuest ? 1 : 0.7}
                onPress={() => !isGuest && handleReaction(r.emoji)}
              >
                <Text style={styles.reactionEmoji}>{r.emoji}</Text>
                <Text style={r.userReacted ? styles.reactionCountActive : styles.reactionCount}>
                  {r.count}
                </Text>
              </TouchableOpacity>
            ))}
          {!isGuest ? (
            <TouchableOpacity
              style={styles.addReactionBtn}
              activeOpacity={0.7}
              onPress={() => setShowEmojiPicker(true)}
            >
              <Text style={styles.addReactionText}>+</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

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
                const url = (r as RecordRow & { txExplorerUrl?: string | null }).txExplorerUrl
                  ?? (r.txHash ? `https://sepolia.basescan.org/tx/${r.txHash}` : null);
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

  return (
    <>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <FlatList
          data={commentList}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <CommentRow
              comment={item}
              currentUserId={sessionUserId}
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

        {/* Fixed bottom comment input */}
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={t('openstoa.postDetail.addCommentPlaceholder')}
            placeholderTextColor={colors.text.tertiary}
            value={draft}
            onChangeText={setDraft}
            editable={!sending && !isGuest}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendButton, (!draft.trim() || sending || isGuest) && styles.sendButtonDisabled]}
            onPress={handleSendComment}
            disabled={!draft.trim() || sending || isGuest}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.sendLabel}>{t('openstoa.postDetail.send')}</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

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
    </>
  );
}
