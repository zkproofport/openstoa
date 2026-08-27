import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, type LayoutChangeEvent, Platform, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useTranslation } from 'react-i18next';
import type { Post } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { formatRelativeTime } from '../utils/relativeTime';
import { MediaGallery } from './MediaGallery';
import { PollRenderer } from './PollRenderer';
import { PostContent, extractMediaItems, stripVideoUrls, type MediaItem } from './PostContent';
import { PostBodyWithOg } from './PostBodyWithOg';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { ArrowUpIcon, ArrowDownIcon, CommentIcon, EyeIcon, ShareIcon, BookmarkIcon, RecordIcon } from './icons';
import Feather from 'react-native-vector-icons/Feather';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { usePostMutations } from '../hooks/usePostMutations';
import { useAuthGuardedAction, useRequireAuth } from '../auth';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
import { GatedImage } from './GatedImage';

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

// Avatar palette — must stay in lockstep with src/components/Avatar.tsx
// (web Avatar). Same hash function (charCodeAt of first letter modulo
// palette length) so the same nickname renders the same colour on web
// and mobile.
const AVATAR_PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#22c55e', // green
  '#06b6d4', // cyan
  '#eab308', // yellow
  '#ef4444', // red
];

function avatarColor(name: string): string {
  const code = name.charCodeAt(0) || 0;
  return AVATAR_PALETTE[code % AVATAR_PALETTE.length];
}

// Fixed visual-height threshold for the "Show more" toggle. Char/line
// counts diverged across languages and HTML tag shapes (Korean filled
// lines slower than English; an embedded image inflated the line count
// without inflating visible height). A pixel cap measured with
// onLayout matches what the user actually sees and mirrors web
// SNSContent's height-based truncation.
const PREVIEW_MAX_HEIGHT = 200;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.background.primary,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    // Pinned posts get a 3px brand-primary left accent + a subtle tint
    // so they read as elevated in the list (Reddit/Discourse pattern).
    // Padding adjusted to keep the body aligned with non-pinned cards.
    cardPinned: {
      borderLeftWidth: 3,
      borderLeftColor: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted + '20',
      paddingLeft: 13,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    // Author header row — mirrors the web PostCard which shows an
    // author avatar + nickname + relative time stacked above the title.
    // Avatar uses the same 24px size as web (`Avatar` size=24).
    authorRow: {
      flexDirection: 'row',
      // Center the 24px avatar against the single-line nickname/timestamp
      // row. `flex-start` top-aligned the taller avatar with the smaller
      // text row, so the nickname rode high and read as misaligned.
      alignItems: 'center',
      gap: 10,
      marginBottom: 8,
    },
    authorAvatar: {
      width: 24,
      height: 24,
      borderRadius: RADIUS.pill,
    },
    authorAvatarFallback: {
      width: 24,
      height: 24,
      borderRadius: RADIUS.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    authorAvatarFallbackText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700',
      color: '#fff',
    },
    authorMetaRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    },
    authorNickname: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '500',
      color: colors.text.secondary,
    },
    authorTimestamp: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      fontVariant: ['tabular-nums'],
    },
    authorSeparator: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },
    // Topic + joined badge live in the same row; the joined chip sits
    // immediately right of the topic chip and matches its height. Style
    // mirrors PostDetailScreen.joinedBadge (success-tint background, success
    // text) so the same post reads the same across feed and detail.
    topicRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    joinedBadge: {
      backgroundColor: colors.status.success + '22',
      borderRadius: RADIUS.control,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    joinedBadgeText: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.status.success,
    },
    topicLabel: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.brand.primary,
      backgroundColor: colors.brand.primaryMuted,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: RADIUS.control,
      overflow: 'hidden',
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
      // Aligned with web PostCard (18px / 700). The 15/600 mobile size was
      // visually understated relative to the body content — bumping size +
      // weight makes the title win the hierarchy the same way it does on
      // the web feed.
      fontSize: TYPE_SCALE.bodyLarge,
      fontWeight: '700',
      color: colors.text.primary,
      lineHeight: 24,
      letterSpacing: -0.2,
      flexShrink: 1,
    },
    content: {
      fontSize: TYPE_SCALE.body,
      color: colors.text.secondary,
      lineHeight: 18,
    },
    toggleRow: {
      paddingTop: 6,
      paddingBottom: 2,
    },
    toggleText: {
      fontSize: TYPE_SCALE.caption,
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
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    countSep: {
      fontSize: TYPE_SCALE.label,
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
      borderRadius: RADIUS.control,
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
      borderRadius: RADIUS.pill,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaPlayGlyph: { color: '#fff', fontSize: TYPE_SCALE.label, marginLeft: 2 },
    mediaMoreOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaMoreText: { color: '#fff', fontSize: TYPE_SCALE.bodySmall, fontWeight: '700' },
    mediaVideoLabel: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaVideoLabelText: { color: colors.text.tertiary, fontSize: TYPE_SCALE.label },
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
      borderRadius: RADIUS.control,
      backgroundColor: colors.brand.primaryMuted,
    },
    tagChipText: {
      fontSize: TYPE_SCALE.label,
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
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.secondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
    },
    reactionPillActive: {
      backgroundColor: colors.brand.primaryMuted,
      borderColor: colors.brand.primary,
    },
    reactionEmoji: {
      fontSize: TYPE_SCALE.caption,
    },
    reactionCount: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    reactionCountActive: {
      fontSize: TYPE_SCALE.label,
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
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
    },
    actionIconActive: {
      fontSize: TYPE_SCALE.bodySmall,
    },
    actionCount: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    actionCountActive: {
      fontSize: TYPE_SCALE.label,
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
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    votePillBtn: {
      paddingHorizontal: 2,
      paddingVertical: 1,
    },
    votePillCount: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
      color: colors.text.secondary,
      minWidth: 12,
      textAlign: 'center',
    },
    votePillCountActive: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
    },
  });
}

/**
 * The routes a PostCard can reach from wherever it happens to be mounted.
 *
 * The card is rendered from all four stacks (Feed / Topics / Profile / Chat)
 * and each of them registers `InAppBrowser` with exactly this param shape —
 * see `src/navigation/stacks/*.tsx`, and the "external links open in the
 * in-app WebView" rule that requires every such stack to carry it. Typing the
 * hook with the intersection is what lets `navigate` be checked at all: a bare
 * `useNavigation()` resolves to the empty global param list, where every
 * argument is `never` and only a double `as never` compiles.
 */
type PostCardRoutes = {
  InAppBrowser: { url: string; title?: string };
};

export function PostCard({ post, topicTitle, onPress }: PostCardProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const navigation = useNavigation<NavigationProp<PostCardRoutes>>();
  const styles = makeStyles(colors);
  const [expanded, setExpanded] = useState(false);
  // Overflow tracked by measuring the body's natural height with onLayout
  // and comparing against PREVIEW_MAX_HEIGHT. When overflow is true, we
  // clip via maxHeight + overflow:hidden until the user expands.
  const [bodyOverflow, setBodyOverflow] = useState(false);

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
      Alert.alert(t('openstoa.common.shareFailed'), msg);
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
  // Measure body height via onLayout. When the natural height exceeds
  // PREVIEW_MAX_HEIGHT, we surface the "Show more" toggle and keep the
  // outer wrapper capped. Once expanded, the cap is lifted so any clipped
  // media / OG card becomes visible too.
  const handleBodyLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > PREVIEW_MAX_HEIGHT && !bodyOverflow) setBodyOverflow(true);
  }, [bodyOverflow]);

  return (
    <View style={[styles.card, post.isPinned ? styles.cardPinned : null]}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.75}>
        {/* Topic chip + Joined badge — mirrors the web PostCard breadcrumb
            row. Lives above the author row so the reader sees TOPIC →
            AUTHOR → TITLE in the same Reddit / Threads order on both
            clients. */}
        {topicTitle || post.isJoinedTopic ? (
          <View style={[styles.header, { marginBottom: 6 }]}>
            <View style={styles.topicRow}>
              {topicTitle ? (
                <Text style={styles.topicLabel} numberOfLines={1}>
                  {topicTitle}
                </Text>
              ) : null}
              {post.isJoinedTopic ? (
                <View style={styles.joinedBadge}>
                  <Text style={styles.joinedBadgeText}>
                    {t('openstoa.topics.joinedBadge')}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* Author row — avatar + nickname + relative time. Matches the web
            PostCard which renders a 24px Avatar followed by nickname and
            mono-formatted timestamp. AvatarFallback uses the first
            character coloured against a hash-derived palette so the
            visual parity holds even when the author hasn't uploaded a
            profile image. */}
        <View style={styles.authorRow}>
          {post.authorProfileImage ? (
            <GatedImage
              uri={post.authorProfileImage}
              style={styles.authorAvatar}
              resizeMode="cover"
            />
          ) : (
            <View
              style={[
                styles.authorAvatarFallback,
                { backgroundColor: avatarColor(post.authorNickname ?? '?') },
              ]}
            >
              <Text style={styles.authorAvatarFallbackText}>
                {(post.authorNickname ?? '?').charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.authorMetaRow}>
            <Text style={styles.authorNickname} numberOfLines={1}>
              {post.authorNickname ?? t('openstoa.postCard.author.anon')}
            </Text>
            <Text style={styles.authorSeparator}>·</Text>
            <Text style={styles.authorTimestamp}>
              {formatRelativeTime(post.createdAt)}
            </Text>
          </View>
        </View>

        {/* Title — pinned posts get a small thumbtack icon prefix
            (MaterialCommunityIcons 'pin' is the real push-pin glyph; Feather's
            map-pin is a GPS marker and was the wrong shape). */}
        <View style={styles.titleRow}>
          {post.isPinned ? (
            <MaterialCommunityIcons
              name="pin"
              size={15}
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
            secondary gallery for skim navigation. The outer wrapper
            caps the body at PREVIEW_MAX_HEIGHT until expanded; onLayout
            on the inner View measures natural height to decide whether
            the "Show more" toggle is needed. PostBodyWithOg renders OG
            cards inline even while clipped — they only become visible
            once the user taps Show more. */}
        {rawContent ? (
          <View
            style={
              expanded
                ? undefined
                : { maxHeight: PREVIEW_MAX_HEIGHT, overflow: 'hidden', position: 'relative' }
            }
          >
            <View onLayout={handleBodyLayout}>
              <PostBodyWithOg
                content={stripVideoUrls(rawContent)}
                onOpenUrl={(url) => navigation.navigate('InAppBrowser', { url })}
              />
            </View>
            {/* Bottom fade so the last partial line dissolves into the card
                background instead of cutting a row of text mid-glyph. Only
                while clipped + overflowing. */}
            {!expanded && bodyOverflow ? (
              <LinearGradient
                pointerEvents="none"
                colors={[colors.background.primary + '00', colors.background.primary]}
                style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48 }}
              />
            ) : null}
          </View>
        ) : null}
      </TouchableOpacity>

      {/* "Show more" toggle when the body overflowed the fixed pixel cap.
          Tapping lifts the cap, revealing any clipped text, inline media,
          and OG card. Media block below is a separate gallery and is
          always shown regardless of expand state. */}
      {bodyOverflow ? (
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
        /*
         * The authors' own descriptions, carried through from the post body.
         *
         * Built from the SAME list the gallery draws, so a picture that appears
         * in both sources keeps whichever description exists rather than
         * silently getting none. Pictures with no description are simply absent
         * from the map — see `altProps` in MediaGallery for why an absent entry
         * and an empty one are handled differently.
         */
        imageAlts={(() => {
          const out: Record<string, string> = {};
          for (const m of mediaItems) {
            if (m.type === 'image' && m.alt !== undefined) out[m.src] = m.alt;
          }
          return out;
        })()}
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
        // Tapping any image in the feed carousel opens PostDetail; horizontal
        // pan still routes to the ScrollView so swipe between images keeps
        // working. Without this, the carousel sits inside the post card but
        // image taps did nothing because PostCard wraps the content (not the
        // media block) in the outer TouchableOpacity.
        onImagePress={() => onPress()}
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
