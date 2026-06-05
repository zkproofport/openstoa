import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Image, Platform, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Post } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { formatRelativeTime } from '../utils/relativeTime';
import { MediaGallery } from './MediaGallery';
import { PollRenderer } from './PollRenderer';
import { PostContent, extractMediaItems, stripVideoUrls, type MediaItem } from './PostContent';
import { PostBodyWithOg } from './PostBodyWithOg';
import { useNavigation } from '@react-navigation/native';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, RecordIcon } from './icons';
import Feather from 'react-native-vector-icons/Feather';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { usePostMutations } from '../hooks/usePostMutations';
import { useAuthGuardedAction, useRequireAuth } from '../auth';

// Lazy clipboard load — same pattern as ChatRoomScreen
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default;
function loadClipboard(): ClipboardModule | null {
  try {
    return (require('@react-native-clipboard/clipboard') as { default: ClipboardModule }).default;
  } catch {
    return null;
  }
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

// List endpoints attach a `reactions` array per post (see server-side
// attachReactionsToPosts helper). It's optional because not every Post
// shape we render originates from those endpoints.
export interface PostCardProps {
  post: Post & { reactions?: ReactionSummary[] };
  topicTitle?: string;
  onPress: () => void;
}

// Single criterion for offering a "Show more" toggle: line count of the
// raw body exceeds the visible preview. Character-based thresholds were
// inconsistent across languages (Korean filled lines slower, English
// filled lines faster), so the previous mixed criterion (`length > 300
// || lines > 5`) made the toggle appear at unpredictable heights. Line
// count alone keeps it deterministic — the preview always shows up to
// PREVIEW_LINES, and anything beyond gets a toggle.
const PREVIEW_LINES = 5;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.background.primary,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    topicLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: 'hidden',
    },
    meta: {
      fontSize: 12,
      color: colors.text.tertiary,
      flexShrink: 1,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginBottom: 4,
    },
    titlePinIcon: {
      marginTop: 2,
    },
    title: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text.primary,
      lineHeight: 20,
      flexShrink: 1,
    },
    content: {
      fontSize: 13,
      color: colors.text.secondary,
      lineHeight: 18,
    },
    toggleRow: {
      paddingTop: 6,
      paddingBottom: 2,
    },
    toggleText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
      gap: 4,
    },
    countText: {
      fontSize: 12,
      color: colors.text.tertiary,
    },
    countSep: {
      fontSize: 12,
      color: colors.border.strong,
    },
    mediaStrip: {
      flexDirection: 'row',
      gap: 6,
      marginTop: 8,
    },
    mediaTile: {
      width: 80,
      height: 80,
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
      position: 'relative',
    },
    mediaThumb: { width: '100%', height: '100%' },
    mediaPlayOverlay: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: 28,
      height: 28,
      marginLeft: -14,
      marginTop: -14,
      borderRadius: 14,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaPlayGlyph: { color: '#fff', fontSize: 12, marginLeft: 2 },
    mediaMoreOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaMoreText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    mediaVideoLabel: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaVideoLabelText: { color: colors.text.tertiary, fontSize: 12 },
    // Action bar
    actionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingTop: 10,
      paddingBottom: 4,
    },
    tagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingTop: 8,
    },
    tagChip: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 4,
      backgroundColor: colors.brand.primaryMuted,
    },
    tagChipText: {
      fontSize: 11,
      color: colors.brand.primary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    // Compact reaction pill row shown between the post body and the
    // primary action bar. Display-only here — tapping a pill opens the
    // post detail where the full reaction picker lives. Slack-style.
    reactionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingTop: 8,
    },
    reactionPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
      backgroundColor: colors.background.secondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    reactionPillActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    reactionEmoji: {
      fontSize: 13,
    },
    reactionCount: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    reactionCountActive: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 6,
      paddingHorizontal: 4,
    },
    actionIcon: {
      fontSize: 14,
      color: colors.text.tertiary,
    },
    actionIconActive: {
      fontSize: 14,
    },
    actionCount: {
      fontSize: 12,
      color: colors.text.tertiary,
    },
    actionCountActive: {
      fontSize: 12,
    },
    actionSpacer: {
      flex: 1,
    },
    votePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 16,
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    votePillBtn: {
      paddingHorizontal: 2,
      paddingVertical: 1,
    },
    votePillCount: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.secondary,
      minWidth: 12,
      textAlign: 'center',
    },
    votePillCountActive: {
      fontSize: 13,
      fontWeight: '700',
    },
  });
}

export function PostCard({ post, topicTitle, onPress }: PostCardProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const navigation = useNavigation();
  const styles = makeStyles(colors);
  const [expanded, setExpanded] = useState(false);

  const client = useOpenStoaClient();
  const sessionUserId = useOpenStoaSession((s: { userId: string | null }) => s.userId);
  const { isGuest } = useRequireAuth();
  const { vote, toggleBookmark } = usePostMutations(post.id);

  // No local mirror of vote/bookmark/record state. Reading directly from
  // the post prop means every screen that renders this card stays in
  // sync the moment the React Query cache is patched — which is what
  // `usePostMutations` does under the hood. Adding useState here is what
  // caused the "tap upvote, go back, see old value" desync the user kept
  // hitting.
  // Guests must never see user-state on a post — even if the server (or a
  // stale cache from a previous authenticated session) returns userVoted /
  // userBookmarked / userRecorded fields, force them to the neutral view so
  // the UI matches the actual auth state. The mutation paths gate again
  // via signInGate.require() before firing.
  const userVote = isGuest ? null : ((post.userVoted ?? null) as 1 | -1 | null);
  const upvoteCount = post.upvoteCount;
  const bookmarked = isGuest ? false : !!post.userBookmarked;
  const recorded = isGuest ? false : !!post.userRecorded;
  const recordCount = post.recordCount ?? 0;

  // Transient UI state only — these are local-by-design and have no
  // cross-screen meaning.
  const [recording, setRecording] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `useAuthGuardedAction` makes the gate-with-replay implicit: guests see
  // the SignInSheet on tap; authed users fire immediately; the action
  // auto-runs after a successful sign-in. No screen needs to know how the
  // gate works internally.
  const handleVote = useAuthGuardedAction((value: 1 | -1) =>
    vote(value, { userVoted: userVote, upvoteCount }),
  );

  const handleBookmark = useAuthGuardedAction(() =>
    toggleBookmark(bookmarked),
  );

  const handleShare = useCallback(async () => {
    // Mirrors the web version: open the OS-native share sheet (parity
    // with `navigator.share`). The user can pick "Copy Link", Messages,
    // AirDrop, etc. — much richer than the previous "always copy URL"
    // behaviour which gave no feedback differentiation from a tap.
    const url = `${client.getBaseUrl()}/topics/${post.topicId}/posts/${post.id}`;
    try {
      await Share.share({ message: url, url, title: post.title ?? 'OpenStoa post' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Share failed', msg);
    }
  }, [client, post.id, post.topicId, post.title]);

  const handleRecord = useCallback(() => {
    if (recording || recorded) return;
    // Recording is an irreversible on-chain action with a confirmation
    // prompt that explains the cost. Centralise that flow on the post
    // detail screen rather than duplicating the Alert here — tapping
    // the record action in a list takes the user there.
    onPress();
  }, [recording, recorded, onPress]);

  const rawContent = post.content ?? '';

  // Extract images + YouTube + Vimeo from the HTML body. Inline `<img>`
  // tags are rendered by PostContent in place, so duplicating them in the
  // 80×80 strip below was both visual noise AND a source of the picsum/
  // randomized-host divergence the user kept hitting (two `<Image>`
  // components fetching the same URL got two different responses). The
  // strip now carries ONLY video items — those don't render inline since
  // `stripVideoUrls` removed their URLs from the body.
  // Unified media items: combine content-extracted (legacy posts) with the
  // new structured `post.media.videos` (Phase A+). Images from `media.images`
  // render through MediaPreview separately so PostContent doesn't have to
  // know about them.
  const mediaItems = useMemo(() => {
    const fromContent = extractMediaItems(rawContent);
    const fromMediaVideos: MediaItem[] = [];
    for (const url of post.media?.videos ?? []) {
      const yt =
        /(?:youtube\.com\/watch\?[^\s]*v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/.exec(url);
      if (yt) {
        fromMediaVideos.push({
          type: 'youtube',
          src: yt[1],
          thumbnail: `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg`,
        });
        continue;
      }
      const vm = /vimeo\.com\/(\d+)/.exec(url);
      if (vm) {
        fromMediaVideos.push({ type: 'vimeo', src: vm[1], thumbnail: '' });
      }
    }
    const seen = new Set<string>();
    return [...fromMediaVideos, ...fromContent].filter((m) => {
      const k = `${m.type}:${m.src}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [rawContent, post.media?.videos]);
  // "Show more" toggles the body text between the PREVIEW_LINES preview
  // and the full content. Driven purely by line count so the toggle
  // appears at a consistent body height regardless of language / per-line
  // character density. Media is its own block now, so it doesn't influence
  // the toggle eligibility — only the body line count matters.
  const isLong = rawContent.split('\n').length > PREVIEW_LINES;

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.75}>
        {/* Header: topic + author + time */}
        <View style={styles.header}>
          {topicTitle ? (
            <Text style={styles.topicLabel} numberOfLines={1}>
              {topicTitle}
            </Text>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {post.authorNickname ?? t('openstoa.postCard.author.anon')} · {formatRelativeTime(post.createdAt)}
          </Text>
        </View>

        {/* Title — pinned posts get a small purple map-pin icon prefix so
            the audience can tell at a glance which one a topic owner/admin
            has pinned. Replaces the previous 📌 emoji prefix for a more
            modern, theme-consistent treatment. */}
        <View style={styles.titleRow}>
          {post.isPinned ? (
            <Feather
              name="map-pin"
              size={14}
              color={colors.brand.primary}
              style={styles.titlePinIcon}
            />
          ) : null}
          <Text style={styles.title} numberOfLines={2}>
            {post.title}
          </Text>
        </View>

        {/* Content preview. YouTube/Vimeo URLs are always stripped from
            the rendered body (the thumbnail strip carries them). Inline
            <img> tags stay — web's SNSContent renders the big inline
            image at full width and the 80x80 strip below acts as a
            secondary gallery for skim navigation. */}
        {rawContent ? (
          <PostBodyWithOg
            content={stripVideoUrls(rawContent)}
            maxLines={expanded ? undefined : PREVIEW_LINES}
            onOpenUrl={(url) => navigation.navigate('InAppBrowser' as never, { url } as never)}
          />
        ) : null}
      </TouchableOpacity>

      {/* "Show more" toggle for long bodies. Media is always shown — it's
          its own block now, not gated on expand state. */}
      {isLong ? (
        <TouchableOpacity
          style={styles.toggleRow}
          activeOpacity={0.7}
          onPress={() => setExpanded((v) => !v)}
        >
          <Text style={styles.toggleText}>
            {expanded ? t('openstoa.postCard.showLess') : t('openstoa.postCard.more')}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Unified media block — image carousel + first video (with +N
          badge). Same shape as the Preview screen and PostDetailScreen so
          the user's draft matches what gets rendered in the feed. Reads
          `post.media.{images,videos}` directly; legacy posts where media
          URLs were inlined in `content` still extract via mediaItems and
          are merged in. */}
      {/* Unified media block — image carousel + first video + "+N" badge.
          Pulls images and videos from BOTH `post.media.{images,videos}`
          and any URLs hiding inside legacy HTML `content`, deduped by
          URL/videoId. PostContent renders inline `<img>` tags too — the
          duplication is intentional so legacy posts still show the
          gallery preview the user expects. With real R2 URLs the same
          src means the same picture; if you point a placeholder service
          (picsum.photos) at the gallery you'll see two different random
          images and that is the service's behaviour, not a bug here. */}
      <MediaGallery
        images={(() => {
          const fromMedia = post.media?.images ?? [];
          const fromContent = mediaItems.filter((m) => m.type === 'image').map((m) => m.src);
          const seen = new Set<string>();
          return [...fromMedia, ...fromContent].filter((u) => {
            if (seen.has(u)) return false;
            seen.add(u);
            return true;
          });
        })()}
        videos={mediaItems
          .filter((m) => m.type === 'youtube' || m.type === 'vimeo')
          .map((m) => (m.type === 'youtube' ? `https://youtu.be/${m.src}` : `https://vimeo.com/${m.src}`))}
        mode="feed"
        horizontalPadding={32}
      />

      {/* Poll — when the post has an attached poll, render the
          interactive vote UI. Wire mutations through the shared cache
          patcher so vote bars stay in sync with the detail view. */}
      {post.poll ? <PollRenderer postId={post.id} poll={post.poll} /> : null}

      {/* Tags chip row — order matches the Twitter/X-style layout the
          user picked (Title → Body → Media → Poll → Tags). */}
      {post.tags && post.tags.length > 0 ? (
        <TouchableOpacity onPress={onPress} activeOpacity={0.75}>
          <View style={styles.tagsRow}>
            {post.tags.map((tag) => (
              <View key={tag.slug} style={styles.tagChip}>
                <Text style={styles.tagChipText}>#{tag.name}</Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>
      ) : null}

      {/* Reactions — display-only Slack-style pill row. Tapping a pill
          opens the post detail where the full picker lives. */}
      {post.reactions && post.reactions.length > 0 ? (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onPress}
          style={styles.reactionRow}
        >
          {post.reactions.map((r) => (
            <View
              key={r.emoji}
              style={[
                styles.reactionPill,
                r.userReacted ? styles.reactionPillActive : null,
              ]}
            >
              <Text style={styles.reactionEmoji}>{r.emoji}</Text>
              <Text style={r.userReacted ? styles.reactionCountActive : styles.reactionCount}>
                {r.count}
              </Text>
            </View>
          ))}
        </TouchableOpacity>
      ) : null}

      {/* Action bar — interactive buttons replacing the old plain-text footer */}
      <View style={styles.actionBar}>
        {/* Up/down vote pill — Reddit-style. Tap up to upvote, down to
            downvote, tapping the same direction again removes the vote. */}
        <View style={styles.votePill}>
          <TouchableOpacity
            style={styles.votePillBtn}
            activeOpacity={0.7}
            onPress={() => handleVote(1)}
            hitSlop={8}
          >
            <ArrowUpIcon size={16} filled={userVote === 1} color={colors.text.tertiary} />
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
            hitSlop={8}
          >
            <ArrowDownIcon size={16} filled={userVote === -1} color={colors.text.tertiary} />
          </TouchableOpacity>
        </View>

        {/* Comment — navigates to post detail */}
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={onPress}>
          <CommentIcon size={18} color={colors.text.tertiary} />
          {post.commentCount > 0 ? (
            <Text style={styles.actionCount}>{post.commentCount}</Text>
          ) : null}
        </TouchableOpacity>

        {/* View count — not tappable */}
        {post.viewCount > 0 ? (
          <View style={styles.actionBtn}>
            <EyeIcon size={16} color={colors.text.tertiary} />
            <Text style={styles.actionCount}>{post.viewCount}</Text>
          </View>
        ) : null}

        {/* Share — opens the OS-native share sheet */}
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={handleShare}>
          <ShareIcon size={16} color={colors.text.tertiary} />
        </TouchableOpacity>

        {/* Record on-chain — hidden for post author. Always show the
            count alongside the anchor icon; purple tint indicates the
            current user has recorded this post. */}
        {sessionUserId && sessionUserId !== post.authorId ? (
          <TouchableOpacity
            style={styles.actionBtn}
            activeOpacity={recorded ? 1 : 0.7}
            onPress={handleRecord}
            disabled={recording}
          >
            <RecordIcon size={16} color={recorded ? '#8b5cf6' : colors.text.tertiary} />
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
        ) : null}

        <View style={styles.actionSpacer} />

        {/* Bookmark */}
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.7} onPress={handleBookmark}>
          <BookmarkIcon size={18} filled={bookmarked} color={colors.text.tertiary} filledColor={colors.brand.primary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}
