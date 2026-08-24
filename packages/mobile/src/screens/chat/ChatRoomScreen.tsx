import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../../api/timeout';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Modal,
  Alert,
  Share,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
// NOT react-native's KeyboardAvoidingView — see the `automaticOffset` note at
// the render root for what that one measures and why it cannot be right here.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';
// expo-image-picker is a native module — a top-level import instantiates
// its native bridge at module-load time, which crashes ChatRoomScreen with
// "Cannot find native module 'ExponentImagePicker'" on JS-only Metro
// reloads (the host iOS binary hasn't been rebuilt to include the pod
// yet). Keep it behind a lazy require so the screen renders fine on a
// stale binary and only the attach-button code path errors when actually
// used. Same precaution for @react-native-clipboard/clipboard so the
// chat screen stays bootable when a fresh dev rebuild hasn't shipped.
type ImagePickerModule = typeof import('expo-image-picker');
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default;
function loadImagePicker(): ImagePickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as ImagePickerModule;
  } catch {
    return null;
  }
}
function loadClipboard(): ClipboardModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@react-native-clipboard/clipboard') as { default: ClipboardModule }).default;
  } catch {
    return null;
  }
}
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useTranslation } from 'react-i18next';
import Feather from 'react-native-vector-icons/Feather';
import type { ChatMessage } from '@openstoa/api-types';
import { isSyncingHistory, nextPendingId, isProvisionalId } from '../../lib/chatStatus';
import {
  getChatReadCursorIso,
  markChatRead,
  newestReadable,
} from '../../lib/chatReadCursor';
import { syncChatReadMls, flushChatReadMls } from '../../lib/chatReadSyncHttp';
import { copyTargets } from '../../lib/messageActions';
import { sendPickedAssets } from '../../lib/pickedAttachments';
import { saveAttachment, type AttachmentFile } from '../../lib/saveAttachment';
import { hostAttachmentFs } from '../../lib/attachmentFs';
import { discardDecrypted, downloadCiphertext, writeDecrypted } from '../../lib/chatMediaFiles';
import {
  ChatMediaError,
  MAX_ATTACHMENTS_PER_PICK,
  MAX_CHAT_MEDIA_BYTES,
  addFailedMedia,
  base64ToBytes,
  buildChatMediaBody,
  isFailedMediaExpired,
  parseFailedMedia,
  removeFailedMedia,
  serializeFailedMedia,
  loadEncryptedChatMedia,
  parseChatMediaBody,
  resolveChatMediaMime,
  sendEncryptedChatMedia,
  type ChatMediaEnvelope,
  type ChatMediaLoad,
  type PersistedFailedMedia,
} from '../../lib/chatMedia';
import { displayNickname } from '../../lib/defaultNickname';
import { MessageFailedControls } from '../../components/MessageFailedControls';
import { chatTierOf, usesTopicRootKey, type ChatTier } from '../../lib/chatTierPolicy';
import { chatClaimKey, TIER_CLAIM_VISIBLE_MS } from '../../lib/chatTierExplainer';
import { WaitingStatus } from '../../components/WaitingStatus';
import { buildTiersUrl } from '../../lib/docsLink';

/**
 * A rendered row: the server's shape plus the two states that exist only on
 * this device. A provisional row is on screen before the server has seen it, so
 * it carries a client-side id and must never be treated as a stored message —
 * archiving one would POST a non-uuid messageId.
 */
type LocalMessage = ChatMessage & {
  pending?: boolean;
  failed?: boolean;
  /**
   * For a failed ATTACHMENT: the object key its envelope names.
   *
   * Retry re-sends this exact object instead of re-reading a photo the user
   * would otherwise have to find in the picker again — which on a phone is the
   * expensive half of the whole flow.
   */
  mediaKey?: string;
  /**
   * The attachment's bytes are gone — the collector took them before the app
   * came back. Retry is replaced by an explanation; the row still SHOWS,
   * because silence is the defect this path exists to fix.
   */
  mediaExpired?: boolean;
};


import { useChatSocket } from '../../api/chatSocket';
import { getMlsSessionStore, getTakSessionStore, toDisplayMessageMls, ackDeliveryMls, report } from '../../crypto/mobileTransport';
import {
  mirrorPushSessionToSharedKeychain,
  mirrorTakToSharedKeychain,
} from '../../crypto/sharedKeychainNative';
import type { ArchiveRootState, Visibility } from '../../crypto/takSession';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { OGPreviewCard } from '../../components/OGPreviewCard';
import type { OGData } from '../../components/OGPreviewCard';
import ImageViewerModal from '../../components/ImageViewerModal';
import { ChatImage } from '../../components/ChatImage';
import { PeerProfileCard } from '../../components/PeerProfileCard';
import { TopicMuteButton } from '../../components/TopicMuteButton';
import type { ChatStackParamList } from '../../navigation/stacks/ChatStack';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useAuthGuardedAction } from '../../auth';
import type { PeerProfileTarget } from '../../lib/peerProfile';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

function extractFirstUrl(text: string): string | null {
  const match = URL_REGEX.exec(text);
  URL_REGEX.lastIndex = 0;
  return match ? match[1] : null;
}

function isUrlOnly(text: string): boolean {
  const trimmed = text.trim();
  URL_REGEX.lastIndex = 0;
  const match = URL_REGEX.exec(trimmed);
  URL_REGEX.lastIndex = 0;
  if (!match) return false;
  return match[0] === trimmed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatPage {
  messages: ChatMessage[];
  nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// Last-seen cache — now `../../lib/chatReadCursor`
// ---------------------------------------------------------------------------
// This used to be a private `Map<topicId, iso>` serving one consumer: the
// `?since=<iso>` delta sync below. The chat LIST kept a second, unrelated map
// of its own and wrote it from a row's `onPress`, which is why arriving in a
// room any other way (a push notification tap goes straight to
// `navigation.navigate`) left the list's unread badge untouched. Both now read
// the one cursor, and the room is what writes it. See that module's header.

/**
 * TAK-recovered plaintext per room, for the life of the process.
 *
 * `recovered` reset to {} on every mount, so re-entering a room the user had
 * just read redrew every pre-join row as locked and made them wait through the
 * archive fetch again — the content was already decrypted moments earlier. In
 * memory only: the same process is already holding it on screen.
 */
const recoveredByTopic = new Map<string, Record<string, string>>();

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background.primary },

    // The tier claim, directly under the stack header. Same strip as the web
    // banner: one line that says what this room is, in the tone of what it is.
    // It withdraws after `TIER_CLAIM_VISIBLE_MS` — the header button below
    // brings it back, and carries the tier in the meantime.
    tierBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: colors.brand.primaryMuted,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.default,
    },
    // A room the service can read is not a reassurance — different tone, so the
    // difference registers before the sentence is read.
    tierBannerReadable: {
      backgroundColor: colors.background.tertiary,
    },
    tierBannerText: {
      flex: 1,
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      color: colors.brand.accent,
    },
    tierBannerTextReadable: {
      color: colors.status.warning,
    },
    // Says a key is on its way and what brings it. Warning-toned rather than
    // danger: nothing is broken, and the room repairs itself once the key lands.
    keyWaitNotice: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: colors.background.tertiary,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.default,
    },
    keyWaitText: {
      flex: 1,
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      color: colors.text.primary,
      fontWeight: '600',
    },
    keyWaitHint: {
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      color: colors.text.secondary,
      marginTop: 2,
    },
    tierBannerLink: {
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      textDecorationLine: 'underline',
      color: colors.text.secondary,
    },

    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    emptyText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.tertiary,
    },
    sendFailed: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingRight: 6,
    },
    sendFailedMark: {
      color: colors.status.danger,
      fontWeight: '700',
      fontSize: TYPE_SCALE.caption,
    },
    sendFailedAction: {
      color: colors.status.danger,
      fontSize: TYPE_SCALE.label,
      textDecorationLine: 'underline',
    },
    sendFailedDiscard: {
      color: colors.text.tertiary,
      fontSize: TYPE_SCALE.label,
      textDecorationLine: 'underline',
    },
    // Locked/loading rows read as status, not as content the user wrote.
    lockedBody: {
      fontSize: TYPE_SCALE.body,
      lineHeight: 21,
      fontStyle: 'italic',
      color: colors.text.tertiary,
    },

    listContent: {
      paddingHorizontal: 14,
      paddingTop: 12,
      // Last bubble clearance from the input row. The input row was
      // overlapping at 72 because the FlatList expands to fill the
      // KeyboardAvoidingView and `flexGrow:1` keeps content snug — 16
      // here is just a small bottom inset; the actual clearance comes
      // from the input row being a sibling below the list, not from
      // padding inside the list.
      paddingBottom: 16,
      flexGrow: 1,
    },

    loadingMore: {
      paddingVertical: 10,
      alignItems: 'center',
    },

    // System messages
    systemRow: {
      alignItems: 'center',
      paddingVertical: 6,
      marginVertical: 2,
    },
    systemMsg: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      backgroundColor: colors.background.secondary,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: RADIUS.card,
      overflow: 'hidden',
    },

    // Regular messages
    messageRow: {
      paddingVertical: 3,
      marginBottom: 2,
    },
    messageHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      marginBottom: 2,
      marginTop: 6,
    },
    author: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600',
      color: colors.brand.primary,
      marginRight: 6,
    },
    msgTime: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
    },
    body: {
      fontSize: TYPE_SCALE.body,
      color: colors.text.primary,
      lineHeight: 21,
    },
    link: {
      color: colors.brand.primary,
      textDecorationLine: 'underline',
    },

    // Presence badge in header
    presenceBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      marginRight: 4,
    },
    presenceDot: {
      width: 7,
      height: 7,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.status.success,
      marginRight: 4,
    },
    presenceDotOffline: { backgroundColor: colors.text.tertiary },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: colors.background.primary,
      borderTopLeftRadius: RADIUS.modal,
      borderTopRightRadius: RADIUS.modal,
      paddingVertical: 8,
      paddingBottom: 28,
    },
    sheetItem: {
      paddingVertical: 16,
      paddingHorizontal: 24,
      minHeight: TOUCH_TARGET_MIN,
      justifyContent: 'center',
    },
    sheetItemText: {
      fontSize: TYPE_SCALE.body,
      color: colors.text.primary,
    },
    offlineBar: {
      position: 'absolute',
      left: 12,
      right: 12,
      // Clear of the composer, which is pinned to the bottom of the screen.
      bottom: 76,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.tertiary,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    offlineBarText: {
      flex: 1,
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.primary,
    },
    offlineBarDismiss: {
      fontSize: TYPE_SCALE.bodyLarge,
      color: colors.text.tertiary,
      lineHeight: 20,
    },
    presenceCount: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.secondary,
    },

    // Connection status bar
    statusBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingHorizontal: 12,
      backgroundColor: colors.background.secondary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    statusError: { backgroundColor: '#FFF0F0' },
    statusText: { fontSize: TYPE_SCALE.caption, color: colors.text.secondary },
    statusErrorText: { color: colors.status.danger },

    // Bubble chat styles
    bubbleRow: {
      flexDirection: 'row',
      marginBottom: 2,
      paddingVertical: 1,
    },
    bubbleRowOwn: {
      justifyContent: 'flex-end',
    },
    bubbleRowOther: {
      justifyContent: 'flex-start',
    },
    bubble: {
      maxWidth: '75%' as const,
      borderRadius: RADIUS.modal,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    bubbleOwn: {
      backgroundColor: colors.brand.primary,
      borderBottomRightRadius: RADIUS.control,
    },
    bubbleOther: {
      backgroundColor: colors.background.secondary,
      borderBottomLeftRadius: RADIUS.control,
    },
    bubbleTextOwn: {
      fontSize: TYPE_SCALE.body,
      lineHeight: 21,
      color: '#FFFFFF',
    },
    bubbleTextOther: {
      fontSize: TYPE_SCALE.body,
      lineHeight: 21,
      color: colors.text.primary,
    },
    linkOwn: {
      color: 'rgba(255,255,255,0.95)',
      textDecorationLine: 'underline' as const,
    },
    linkOther: {
      color: colors.brand.primary,
      textDecorationLine: 'underline' as const,
    },
    bubbleAuthorRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginBottom: 2,
      marginLeft: 2,
    },
    bubbleAuthor: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '600' as const,
      color: colors.brand.primary,
    },
    // AI-member badge (design §7 D9 — nickname + AI badge, is_ai=true).
    aiBadge: {
      fontSize: TYPE_SCALE.label,
      fontWeight: '700' as const,
      color: colors.background.primary,
      backgroundColor: colors.brand.primary,
      overflow: 'hidden' as const,
      borderRadius: RADIUS.control,
      paddingHorizontal: 4,
      paddingVertical: 1,
      marginLeft: 6,
    },
    bubbleTime: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.tertiary,
      alignSelf: 'flex-end' as const,
      marginTop: 3,
    },
    bubbleTimeOwn: {
      marginRight: 2,
    },
    bubbleTimeOther: {
      marginLeft: 2,
    },
    bubbleOGWrapOwn: {
      maxWidth: '75%' as const,
      alignSelf: 'flex-end' as const,
      marginTop: 4,
    },
    bubbleOGWrapOther: {
      maxWidth: '75%' as const,
      alignSelf: 'flex-start' as const,
      marginTop: 4,
    },

    // Input bar
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border.default,
      backgroundColor: colors.background.secondary,
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.pill,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === 'ios' ? 10 : 6,
      fontSize: TYPE_SCALE.body,
      color: colors.text.primary,
      backgroundColor: colors.background.primary,
    },
    sendButton: {
      marginLeft: 8,
      width: 44,
      height: 44,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: { backgroundColor: colors.border.strong },
    sendLabel: { color: '#FFFFFF', fontSize: TYPE_SCALE.bodySmall, fontWeight: '600' },
    attachButton: {
      marginRight: 8,
      width: 44,
      height: 44,
      borderRadius: RADIUS.pill,
      backgroundColor: colors.background.tertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachLabel: { color: colors.text.primary, fontSize: TYPE_SCALE.headingSmall },
  });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ChatRoomScreen() {
  const { t } = useTranslation();
  const route = useRoute<any>();
  const navigation = useNavigation<NativeStackNavigationProp<ChatStackParamList>>();
  const topicId: string = route.params?.topicId ?? '';
  const topicTitle: string = route.params?.topicTitle ?? t('openstoa.tabs.chat');
  // 'topic' when the caller didn't say (see ChatStackParamList's doc) — the
  // Members button below is additive chrome, so defaulting to "show it" is
  // the safe direction; a DM param is always passed explicitly by every
  // caller that opens one (ChatListScreen never guesses 'dm').
  const kind: 'topic' | 'dm' = route.params?.kind ?? 'topic';

  const client = useOpenStoaClient();
  const sessionUserId = useOpenStoaSession((s) => s.userId);
  const host = useHost();
  // Pass the host secure store so MLS state persists across restarts (same leaf
  // restored, no re-join). Singleton: first caller (here or chatSocket) wins.
  const mls = getMlsSessionStore(client, host.secureStore, host.localStore);
  const tak = getTakSessionStore(client, host.secureStore, host.localStore);

  /*
   * Failed attachments outlive the process.
   *
   * A phone app is killed by the OS routinely, so a row that lives only in
   * React state is lost far more often here than on the web — and the user did
   * nothing to cause it. What is stored is a REFERENCE (the sealed body and the
   * object key), never the picture; the bytes stay where they were uploaded.
   * The host's non-secure KV is the right home: this is bulk state, not a key.
   */
  const failedMediaStoreKey = `openstoa.failedMedia.${topicId}`;
  const readFailedMedia = useCallback(async (): Promise<PersistedFailedMedia[]> => {
    try {
      const raw = await host.localStore?.getItem(failedMediaStoreKey);
      return parseFailedMedia(raw ?? null, Date.now());
    } catch {
      return [];
    }
  }, [host, failedMediaStoreKey]);
  const writeFailedMedia = useCallback(
    async (list: readonly PersistedFailedMedia[]) => {
      try {
        await host.localStore?.setItem(failedMediaStoreKey, serializeFailedMedia(list));
      } catch {
        /* storage refused — the row still shows for this session */
      }
    },
    [host, failedMediaStoreKey],
  );
  const forgetFailedMedia = useCallback(
    async (rowId: string) => writeFailedMedia(removeFailedMedia(await readFailedMedia(), rowId)),
    [readFailedMedia, writeFailedMedia],
  );

  /* Put back what the last run could not send. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await readFailedMedia();
      if (cancelled || rows.length === 0) return;
      const now = Date.now();
      setSentMessages((curr) => {
        const known = new Set(curr.map((m) => m.id));
        const restored = rows
          .filter((r) => !known.has(r.rowId))
          .map(
            (r) =>
              ({
                id: r.rowId,
                message: r.body,
                // A failed row is this client's by construction, so ownership
                // does not wait on the session lookup.
                userId: '',
                nickname: '',
                createdAt: new Date(r.createdAt).toISOString(),
                type: 'message',
                failed: true,
                mediaKey: r.key,
                // Only a HINT here — retry probes the object for real.
                mediaExpired: isFailedMediaExpired(r, now),
              }) as LocalMessage,
          );
        return restored.length === 0 ? curr : [...curr, ...restored];
      });
      // Persist what the parse kept, so pruned rows are not re-read forever.
      await writeFailedMedia(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [readFailedMedia, writeFailedMedia]);
  // TAK back-fill: recovered plaintext for pre-join messages MLS can't decrypt,
  // keyed by message id; merged into the list below. Topic visibility selects
  // the TAK tier (public root vs scoped) — resolved once on mount.
  const [recovered, setRecovered] = useState<Record<string, string>>(
    () => recoveredByTopic.get(topicId) ?? {},
  );
  /**
   * Merge what a backfill opened into the rendered rows.
   *
   * Extracted because the room now backfills more than once: on entry, and
   * again on the key tick for as long as anything is still sealed. Two copies
   * of "spread it in and update the module cache" is how one of them ends up
   * forgetting the cache.
   */
  const applyBackfill = useCallback(
    (history: Array<{ messageId: string; plaintext: string }>) => {
      setRecovered((prev) => {
        const next = { ...prev };
        for (const h of history) next[h.messageId] = h.plaintext;
        recoveredByTopic.set(topicId, next);
        return next;
      });
    },
    [topicId],
  );
  /**
   * Whether any rendered row is still sealed to this device.
   *
   * A ref, not state: the key tick reads it to decide whether to bother
   * backfilling, and it must not restart the timer every time a message
   * arrives. Kept up to date where the list is assembled.
   */
  const lockedRef = useRef(false);
  // Whether this device can open the topic archive yet. Drives the difference
  // between "your history is on its way" and "something is wrong".
  const [rootState, setRootState] = useState<ArchiveRootState | null>(null);
  /** Whether the archive probe has answered YET — see `isSyncingHistory`. */
  const [rootProbed, setRootProbed] = useState(false);
  // Mirror of the rendered list for the archive gap-filler, which reads the
  // current rows once and must not re-run as messages arrive.
  const allMessagesRef = useRef<LocalMessage[]>([]);
  const visibilityRef = useRef<Visibility>('public');
  /*
   * The tier, for the CRYPTO. Not the same question as the topic's visibility,
   * though it used to be answered with it: a DM row carries
   * `visibility: 'secret'`, so passing the visibility to the TAK layer asked for
   * per-epoch keys on a tier `chatTierPolicy` declares topic-root, and a DM's
   * key never left the device that minted it. `kind` comes from the route, so
   * this is right on the first frame and only narrows when the lookup lands.
   */
  const tierRef = useRef<ChatTier>(chatTierOf(undefined, kind === 'dm'));
  // Same value as the ref, as state: an attachment row decrypts in an effect,
  // so the tier has to reach it as a PROP that changes when the lookup lands.
  const [visibility, setVisibility] = useState<Visibility>('public');
  /*
   * Which claim this room may make. `public` until the visibility lookup lands,
   * which is the tier that promises the LEAST — a room can be upgraded to "the
   * service cannot read this" once that is known to be true, but never
   * downgraded from a promise already made on screen.
   *
   * `kind` comes from the route, so a DM is a DM on the first frame.
   */
  const tier = chatTierOf(visibility, kind === 'dm');
  const claim = chatClaimKey(tier);
  /*
   * The claim's sentence shows on entry, then withdraws — four permanent lines
   * above every conversation is furniture people learn to read past, and the
   * tier where the sentence is a WARNING is the tier most rooms are in.
   *
   * Keyed on `claim`, not on mount: `visibility` arrives from a lookup, so the
   * first frames of a private room say the public sentence (deliberately — see
   * the `tier` comment above). Re-opening when the claim changes is what makes
   * sure the sentence a room actually deserves is the one that gets read,
   * rather than being replaced silently behind an already-expired timer.
   */
  const [claimOpen, setClaimOpen] = useState(true);
  useEffect(() => {
    setClaimOpen(true);
    const timer = setTimeout(() => setClaimOpen(false), TIER_CLAIM_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [claim]);
  const tiersUrl = buildTiersUrl(host.getEnvironment().openstoaBaseUrl);
  // The caller's topic role — secret-tier history is granted only by the owner.
  const roleRef = useRef<string | null>(null);
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  // AI capability is scoped to the individual API key an isAI session
  // authenticates with (Profile → AI agent → API keys), not per-topic here
  // and not an account-wide profile setting either (retired 2026-07-30). The
  // former owner-only "Add AI agent" consent sheet was removed with that redesign.
  const listRef = useRef<FlatList<LocalMessage>>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Local image viewer URL — avoids piping image taps through the
  // in-app WebView, which renders the raw image at top + blank space
  // (the "white area" reported on staging).
  /*
   * What the full-screen viewer is showing, and whether it can be kept.
   *
   * A plain URL was enough while the only thing to do was look. Saving needs
   * the BYTES, which only the attachment that decrypted them has — so the
   * opener supplies a closure rather than the viewer going and fetching
   * anything itself. A pre-R3 inline image is a remote URL with no bytes on
   * this device, so it opens without one and the control simply is not there.
   */
  const [imageViewer, setImageViewer] = useState<{ uri: string; save?: () => void } | null>(null);
  /** The message a long-press opened the copy sheet for, or null. */
  const [actionTarget, setActionTarget] = useState<{ message: string; link: string | null } | null>(null);
  // Peer profile card (author name tap on another member's message).
  // null = closed, same controlled-by-state pattern as the image viewer.
  const [profileTarget, setProfileTarget] = useState<PeerProfileTarget | null>(null);
  const startDmMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      client.post<{ topicId: string }>('/api/dm', { userId }),
    onError: (err: Error) => {
      Alert.alert(t('openstoa.dm.actionFailed'), err.message);
    },
  });
  const openDmFromProfile = useCallback(
    (target: PeerProfileTarget) => {
      if (startDmMutation.isPending) return;
      startDmMutation.mutate(
        { userId: target.userId },
        {
          onSuccess: (res) => {
            setProfileTarget(null);
            // Push a new ChatRoom instance rather than `navigate` — we're
            // already on the 'ChatRoom' route, so `navigate` would just
            // rewrite this screen's params instead of opening a fresh one,
            // and the back button would no longer return to this room.
            navigation.push('ChatRoom', { topicId: res.topicId, topicTitle: target.nickname, kind: 'dm' });
          },
        },
      );
    },
    [startDmMutation, navigation],
  );

  // ── SSE realtime ──────────────────────────────────────────────────────────
  const { messages: liveMessages, presence, status, error } = useChatSocket(topicId);

  // ── Paginated history (cursor-based via ?before=<id>) ─────────────────────
  // Initial page = the latest 50 messages. Older pages use ?before=<id>
  // anchored on the oldest message we've already received, so newly
  // inserted messages don't shift the page window and cause dup/skip
  // (which the previous offset-based pagination was vulnerable to).
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status: historyStatus,
  } = useInfiniteQuery<ChatPage>({
    queryKey: ['chat-history', topicId],
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as string | undefined;
      const qs = cursor === undefined
        ? `limit=50`
        : `limit=50&before=${encodeURIComponent(cursor)}`;
      const res = await client.get<{ messages: ChatPage['messages']; total: number }>(
        `/api/topics/${topicId}/chat?${qs}`,
      );
      // Server returns newest-first; the oldest is the last item. Use the
      // raw row for the cursor (id only), and decrypt sealed bodies for display.
      const oldest = res.messages.length > 0
        ? res.messages[res.messages.length - 1]
        : null;
      const decrypted = await Promise.all(
        res.messages.map((m) => toDisplayMessageMls(mls, topicId, m)),
      );
      // The live copy is a delivery queue (R-1): tell the server what this
      // device now holds so it can release its own. Never throws.
      ackDeliveryMls(client, topicId, decrypted);
      return {
        messages: decrypted,
        nextCursor: res.messages.length === 50 && oldest ? oldest.id : undefined,
      } as ChatPage;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // A message the user sends only ever lives in `liveMessages` (SSE) for
    // the lifetime of this mount — it is never written into this history
    // cache. With the global 30s staleTime, re-entering the room within
    // that window served the stale cached pages (missing the just-sent
    // message) and skipped the catch-up fetch (first open), so the message
    // vanished even though it is persisted server-side. Force a fresh
    // history pull on every mount so re-entry always reflects the DB.
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // ── Catch-up messages fetched via ?since=<iso> on SSE (re)connect ─────────
  // The SSE stream only delivers events that happen after the subscription
  // is live, so any messages that arrived between the previous session and
  // this connection are missing from `liveMessages`. On every transition
  // into the `open` state we ask the server for everything newer than the
  // last message we already have and merge it in.
  const [catchupMessages, setCatchupMessages] = useState<LocalMessage[]>([]);
  // Optimistically-echoed own messages (plaintext). An MLS sender can't decrypt
  // its own sealed message, so without this the SSE echo shows "[unable to
  // decrypt]". Spread FIRST in the merge so it wins the first-wins dedup.
  const [sentMessages, setSentMessages] = useState<LocalMessage[]>([]);

  // ── Merge history + catchup + live, deduplicated, newest last ─────────────
  const allMessages = useMemo<LocalMessage[]>(() => {
    const historyMsgs = (data?.pages ?? []).flatMap((p) => p.messages);

    const seen = new Set<string>();
    const merged: LocalMessage[] = [];
    for (const m of [...sentMessages, ...historyMsgs, ...catchupMessages, ...liveMessages]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        // Fill pre-join rows MLS couldn't decrypt with TAK-recovered history.
        merged.push(
          m.message === '[unable to decrypt]' && recovered[m.id] ? { ...m, message: recovered[m.id] } : m,
        );
      }
    }
    // Sort chronologically (oldest → newest); the FlatList renders top-down.
    merged.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return merged;
  }, [data, sentMessages, catchupMessages, liveMessages, recovered]);

  /** Rows on screen this device cannot open. */
  const lockedCount = useMemo(
    () => allMessages.reduce((n, m) => (m.message === '[unable to decrypt]' ? n + 1 : n), 0),
    [allMessages],
  );
  /*
   * "Still working on it": something is unreadable AND the archive key is
   * either on its way (`waiting`) or not probed yet (`null`).
   *
   * `null` counts. Leaving it out is what ended the spinner before anything was
   * decrypted — the probe had not answered, so the room briefly read as
   * finished, showed placeholder rows, and only decrypted on the NEXT visit.
   */
  const syncing = isSyncingHistory({ lockedCount, rootState, rootProbed });
  // Read by the key tick, which must not re-arm every time a row arrives.
  lockedRef.current = lockedCount > 0;
  /*
   * Locked rows, and the spinner has given up on them.
   *
   * This is the state the report was about: a private room showed a column of
   * "Encrypted — this device has no key for it" and said nothing about what
   * would change it. `isSyncingHistory` cannot cover the scoped tiers — it ends
   * on `rootState === 'waiting'`, which is a PUBLIC-root idea, so private and
   * secret fall straight through to the dead end the moment the probe answers.
   *
   * A key can still arrive: an existing member's client hands it over, and this
   * room keeps asking for as long as it is open. So say that, and say the one
   * thing a person can actually do about it — which for their own second device
   * is to open the room where the history already is.
   */
  const awaitingRoomKey = lockedCount > 0 && !syncing;
  /*
   * While the spinner is up, an unreadable row shows NOTHING rather than a
   * placeholder. One spinner for the room, not a column of identical dots.
   */
  const visibleMessages = useMemo(
    () => (syncing ? allMessages.filter((m) => m.message !== '[unable to decrypt]') : allMessages),
    [allMessages, syncing],
  );

  // ── TAK back-fill + public holder upkeep (Phase 3) ────────────────────────
  // On mount: resolve visibility, then back-fill (ingest bundles + decrypt the
  // archive) to recover pre-join history. For public topics, claim the single-
  // winner holder lease and, if held, distribute the archive root to all member
  // leaves so later joiners can read history. All best-effort — never blocks chat.
  const provisionArchiveAccess = useCallback(async () => {
    try {
      const currentTier = tierRef.current;
      if (currentTier === 'public') {
        const deviceId = await tak.myDeviceId(topicId);
        // Only a device that HOLDS the root may take the role, because the
        // holder is who everyone else receives the root from. A device still
        // waiting for it that claims anyway makes itself the one party nobody
        // will ever send a bundle to — and blocks every newer device behind it.
        const rootFingerprint = await tak.publicRootFingerprint(topicId);
        if (!rootFingerprint) {
          // Waiting for the root. If an earlier visit already took the lease,
          // hand it back now rather than idling on it for the full 15 minutes.
          await client.delete(`/api/topics/${topicId}/tak/holder?deviceId=${encodeURIComponent(deviceId)}`);
          return;
        }
        // 409 (someone else holds the lease) is not a reason to skip the rest.
        await client
          .post(`/api/topics/${topicId}/tak/holder`, { deviceId, rootFingerprint })
          .catch(() => {});
        // Distribute whether or not we won the lease. Gating on the lease made
        // delivery depend on ONE device being online at the right moment, and
        // that is what left a device that joined a minute late with no root at
        // all. Serving is safe from any holder of a verified root: a recipient
        // rejects any bundle whose fingerprint is not the topic's.
        await tak.distributeRootWhenGroupChanged(topicId, currentTier);
      } else if (usesTopicRootKey(currentTier)) {
        /*
         * A DM. Same delivery as public — the root wrapped to every member leaf
         * — minus the holder lease, which is a public-tier mechanism: a DM has
         * two participants and nobody to elect. This is the ONLY way a DM's key
         * travels, because the server is not allowed to hold it.
         */
        await tak.distributeRootWhenGroupChanged(topicId, currentTier);
      } else if (currentTier === 'private') {
        // SI-6b: explicit per-leaf grant of the epochs we hold; no custodian.
        await tak.grantPrivateHistory(topicId);
      } else if (currentTier === 'secret' && roleRef.current === 'owner') {
        // secret: no auto-grant by default — only the owner shares history.
        await tak.grantPrivateHistory(topicId);
      }
    } catch {
      /* lease held elsewhere / nothing to grant — no-op */
    }
  }, [client, tak, topicId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tj = await client.get<{ topic?: { visibility?: string }; visibility?: string; currentUserRole?: string | null }>(`/api/topics/${topicId}`);
        const v = (tj?.topic?.visibility ?? tj?.visibility) as Visibility | undefined;
        if (v === 'public' || v === 'private' || v === 'secret') {
          visibilityRef.current = v;
          setVisibility(v);
        }
        tierRef.current = chatTierOf(visibilityRef.current, kind === 'dm');
        roleRef.current = tj?.currentUserRole ?? null;
      } catch {}
      let history: Array<{ messageId: string; plaintext: string }> = [];
      try {
        history = await tak.backfill(topicId, tierRef.current);
        if (!cancelled && history.length) applyBackfill(history);
      } catch {}
      if (!cancelled) await provisionArchiveAccess();
      // Make removals real. A kick, a leave and an account deletion all end as
      // a missing membership row; the ratchet tree only catches up when some
      // member's client commits the Remove. Doing it on entry rather than in
      // the acting admin's request keeps the group correct when that admin
      // backgrounds the app mid-kick — any member repairs it on their next
      // visit. Best-effort and silent: a failure means the next one tries.
      if (!cancelled) {
        try {
          const { members } = await client.get<{ members: Array<{ userId?: string }> }>(
            `/api/topics/${topicId}/members`,
          );
          const ids = (members ?? []).map((m) => m.userId).filter((id): id is string => !!id);
          // An EMPTY list is refused rather than acted on: far likelier a shape
          // we failed to read than a topic with no members, and acting on it
          // would evict everyone.
          if (ids.length > 0) await mls.reconcileMembership(topicId, ids);
        } catch {}
      }
      // Close archive GAPS, AFTER provisioning — that is where a device that was
      // waiting finally adopts the topic root, and only a verified root may seal.
      // `archiveOnSend` gets one attempt at send time and silently does nothing
      // while the root is unverified, so those messages sit outside the archive
      // forever and are invisible to every device that joins later. Anything this
      // device can read is a chance to put one back. Best-effort.
      if (!cancelled) {
        const readable = [
          ...allMessagesRef.current
            // A provisional row has a client-side id, so archiving it would
            // POST a non-uuid messageId — rejected once per unsent message on
            // every pass. `archiveOnSend` covers it once the server assigns an
            // id.
            .filter(
              (m) =>
                m.type === 'message' &&
                m.message &&
                m.message !== '[unable to decrypt]' &&
                !isProvisionalId(m.id),
            )
            .map((m) => ({ messageId: m.id, plaintext: m.message as string })),
          ...history,
        ];
        void tak.backfillMissingArchive(topicId, tierRef.current, readable).catch(() => {});
      }
      // Mirror this topic's TAK into the shared Keychain (design §13.6 A) AFTER
      // provisioning, so a device that only ever READS the topic still holds the
      // key its notification extension needs — the send path alone would leave
      // pure readers with no preview. Best-effort; iOS-only.
      if (!cancelled) {
        const ref = await tak.takForPush(topicId, tierRef.current);
        if (ref) void mirrorTakToSharedKeychain(topicId, ref.takVersion, ref.takB64, host).catch(() => {});
        /*
         * The key alone previews a MESSAGE. An ATTACHMENT does not fit in a
         * push, so the iOS extension has to fetch it through the
         * membership-gated route — and it cannot ask this process for a token
         * (different process, app not running). Mirrored here, beside the key,
         * so a device that only ever READS a topic still has both by the time a
         * picture arrives (P-1). Best-effort and iOS-only; without it the
         * notification says "📷 Photo" with no thumbnail.
         */
        const cred = await client.pushSessionCredential().catch(() => null);
        if (cred) void mirrorPushSessionToSharedKeychain(topicId, cred.baseUrl, cred.token).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, tak, mls, topicId, provisionArchiveAccess, host]);

  // A new member joined (live SSE) → if we hold the public lease, push them the
  // archive root so they can back-fill (membership-change distribution, SI-6).
  const lastJoinRef = useRef<string | null>(null);
  useEffect(() => {
    for (let i = liveMessages.length - 1; i >= 0; i--) {
      if (liveMessages[i].type === 'join') {
        if (liveMessages[i].id !== lastJoinRef.current) {
          lastJoinRef.current = liveMessages[i].id;
          void provisionArchiveAccess();
        }
        break;
      }
    }
  }, [liveMessages, provisionArchiveAccess]);

  // ── Track last-seen timestamp per topic + drive SSE reconnect catchup ────
  // Update the cross-mount last-seen marker every time the bottom of the
  // merged list advances. This is what `?since=<iso>` keys off.
  // The RECEIVING half of root delivery. Bundles are pulled, never pushed, and
  // the pull used to happen once per room entry — so a device that was still
  // waiting when it opened the room never saw the bundle created seconds later.
  // Poll while this device cannot open the archive, and stop the moment it can.
  useEffect(() => {
    let alive = true;
    // Backoff, starting FAST. A fixed slow interval meant a newcomer stared at
    // padlocks for the whole period even when the key was already waiting.
    let delay = 1_500;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<boolean> => {
      try {
        // Ask the SERVER, every tick. The resolver caches a 'waiting' answer for
        // fifteen seconds, so without this the retries were answered from that
        // cache and a bundle arriving moments after this device joined went
        // unseen until the room was closed and reopened.
        tak.forgetUnsettledRoot(topicId);
        const state = await tak.archiveRootState(topicId, tierRef.current);
        // null = a scoped tier with no topic-wide root, so there is nothing to
        // wait for and nothing to decrypt from an archive.
        if (state === null) {
          if (alive) setRootState(state);
          return true;
        }
        // Decrypt BEFORE reporting the new state. The previous version stopped
        // the moment the root became 'verified' — precisely the pass that can
        // finally open the history — so the spinner ended over a room still
        // showing placeholders, and nothing decrypted until the user left the
        // room and came back.
        const history = await tak.backfill(topicId, tierRef.current);
        if (alive && history.length) {
          setRecovered((prev) => {
            const next = { ...prev };
            for (const h of history) next[h.messageId] = h.plaintext;
            recoveredByTopic.set(topicId, next);
            return next;
          });
        }
        /*
         * Re-read AFTER back-filling, and report THAT.
         *
         * `state` above was read before `backfill` — and `backfill` is what
         * ingests the bundle, adopts the root and decrypts. So the one pass that
         * actually unlocks the room used to report the state from before it did
         * so ('waiting'), leave the spinner up, and schedule another tick. The
         * work had already succeeded; only the answer was stale.
         */
        const settled = (await tak.archiveRootState(topicId, tierRef.current)) ?? state;
        /*
         * Every tick, to the server sink — this path has now been diagnosed
         * three times from screenshots, and a screenshot cannot say whether the
         * bundle arrived, whether the root was adopted, or how many rows came
         * back. Names and counts only, never key material or message content.
         */
        report('chat/root-tick', {
          topicId,
          before: state,
          after: settled,
          recovered: history.length,
          locked: allMessagesRef.current.reduce(
            (n, m) => (m.message === '[unable to decrypt]' ? n + 1 : n),
            0,
          ),
        });
        if (alive) setRootState(settled);
        return settled === 'verified';
      } catch {
        return false;
      } finally {
        // Settled either way. A failed probe is an ANSWER — it stops the
        // spinner and lets the locked rows explain themselves.
        if (alive) setRootProbed(true);
      }
    };
    const schedule = () => {
      timer = setTimeout(() => {
        void tick().then((done) => {
          if (!alive || done) return;
          // Capped low while the room is OPEN and its history is locked: the
          // reader is looking at a spinner, and a fifteen-second gap between
          // attempts is most of the time they are willing to wait.
          delay = Math.min(delay * 2, 5_000);
          schedule();
        });
      }, delay);
    };
    void tick().then((done) => {
      if (!alive || done) return;
      schedule();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tak, topicId]);

  /*
   * Keep handing keys out, and keep picking them up, for as long as the room is
   * open.
   *
   * A device that joins AFTER the keys went round receives nothing, and that
   * lasted "until some other device happens to reopen the chat" — reproducibly
   * minutes, or forever. A repeating tick fixed that for PUBLIC rooms and the
   * scoped tiers never got it, so a private room's second device sat on
   * "Encrypted — this device has no key for it" until a member reopened the
   * chat. Reproduced in `inviteHistoryRepro.test.ts`: the crypto is fine, the
   * grant works, it simply was not being run again.
   *
   * Both directions, because a tick that only GIVES leaves the device that
   * needs the key waiting for its own next visit to notice what arrived:
   *
   *   give — the tier's own hand-out. Each is a no-op unless the group actually
   *          changed, so the steady state costs one commits-since GET.
   *   take — re-run the backfill, but only while something is still locked. A
   *          room with nothing sealed does no work at all.
   */
  useEffect(() => {
    let delay = 3_000;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const give = async () => {
      const currentTier = tierRef.current;
      /*
       * The DM early return that used to be here is why this ticker never
       * unlocked a DM: it is the retry that covers a peer device joining while
       * this one is on screen, and DMs were excluded from it on the belief that
       * they needed no delivery at all.
       */
      if (usesTopicRootKey(currentTier)) {
        await tak.distributeRootWhenGroupChanged(topicId, currentTier);
        return;
      }
      // Same rule the one-shot on room open uses: private grants from any
      // member, secret only from the owner.
      if (currentTier === 'private' || roleRef.current === 'owner') {
        await tak.grantPrivateHistory(topicId);
      }
    };

    const take = async () => {
      if (!lockedRef.current) return;
      const history = await tak.backfill(topicId, tierRef.current);
      if (!alive || history.length === 0) return;
      applyBackfill(history);
    };

    const schedule = () => {
      timer = setTimeout(() => {
        void give()
          .catch(() => {})
          .then(take)
          .catch(() => {})
          .finally(() => {
            if (!alive) return;
            // Doubling from a short first interval: the device that joined a
            // second ago is the case that matters, and making it wait out a
            // fixed half-minute is the complaint itself.
            delay = Math.min(delay * 2, 60_000);
            schedule();
          });
      }, delay);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tak, topicId, kind, applyBackfill]);

  // Being in the room IS reading it. Runs on mount once history lands and on
  // every change after, so the cursor tracks what is on screen no matter how
  // the user got here — the push-notification tap included, which previously
  // recorded nothing at all and left the list badging messages just read.
  //
  // `newestReadable` rather than the last element: a row the user just sent is
  // on screen before the server has stored it, and its id and clock are the
  // device's. See `markChatRead` for why recording one would be worse than
  // recording nothing.
  useEffect(() => {
    allMessagesRef.current = allMessages;
    if (allMessages.length === 0) return;
    // Local first, then the server. The local cursor is a CACHE and it is what
    // makes the badge drop the instant the user walks in — waiting for a round
    // trip would leave the list they came from showing a count for messages
    // that are on screen. The server write is debounced and fire-and-forget;
    // see `chatReadSync` for why a failure here may do nothing at all.
    markChatRead(topicId, newestReadable(allMessages));
    syncChatReadMls(client, topicId, allMessages);
  }, [allMessages, topicId, client]);

  // Leaving the room is when the write matters most and is most likely to be
  // still sitting in the debounce window. Flush on unmount so the badge clears
  // on this account's OTHER devices now rather than on the next visit.
  useEffect(() => {
    return () => {
      flushChatReadMls(topicId);
    };
  }, [topicId]);

  // When SSE transitions to `open`, fetch any messages newer than what we
  // already have. Initial connect of a freshly-opened screen has nothing
  // newer to fetch; reconnect after a drop is the path that benefits.
  const prevSseStatusRef = useRef<typeof status>('idle');
  useEffect(() => {
    const prev = prevSseStatusRef.current;
    prevSseStatusRef.current = status;
    if (status !== 'open') return;
    const cursorIso = getChatReadCursorIso(topicId);
    // No anchor yet (very first connect with no history loaded) — nothing
    // to delta-sync against; the initial useInfiniteQuery fetch covers it.
    if (!cursorIso) return;
    // Skip the very first open if there's no prior status to reconnect from.
    if (prev === 'idle' || prev === 'connecting') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await client.get<{ messages: ChatMessage[]; total: number }>(
          `/api/topics/${topicId}/chat?limit=500&since=${encodeURIComponent(cursorIso)}`,
        );
        if (cancelled || res.messages.length === 0) return;
        const decrypted = await Promise.all(
          res.messages.map((m) => toDisplayMessageMls(mls, topicId, m)),
        );
        if (cancelled) return;
        ackDeliveryMls(client, topicId, decrypted);
        setCatchupMessages((curr) => {
          const ids = new Set(curr.map((m) => m.id));
          const next = [...curr];
          for (const m of decrypted) if (!ids.has(m.id)) next.push(m);
          return next;
        });
      } catch (e) {
        console.log('[CHAT] catchup fetch failed', {
          topicId,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, topicId, client]);

  // ── Auto-scroll: track bottom message id + user-near-bottom flag ──────────
  // We deliberately do NOT key off `liveMessages.length` alone — the user
  // sending a message also echoes back via the socket, so the source of
  // truth for "did the bottom move?" is the id of the last item in the
  // merged list. This also distinguishes new bottom messages (scroll!)
  // from older history pages being prepended (don't scroll).
  const lastBottomIdRef = useRef<string | null>(null);
  const userNearBottomRef = useRef(true);

  const scrollToBottom = useCallback((animated: boolean) => {
    // Schedule two scrolls: one on the next frame (after layout settles)
    // and another after ~300 ms to catch async-rendered children like the
    // OG preview card and inline images, which only push content height
    // once their network fetch resolves.
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
    }, 300);
  }, []);

  useEffect(() => {
    if (allMessages.length === 0) return;
    const newLastId = allMessages[allMessages.length - 1]?.id ?? null;
    if (newLastId && newLastId !== lastBottomIdRef.current) {
      const wasFirstLoad = lastBottomIdRef.current === null;
      lastBottomIdRef.current = newLastId;
      // After scrolling, assume we're at the bottom so subsequent
      // onContentSizeChange callbacks (OG card rendering) keep us pinned.
      userNearBottomRef.current = true;
      scrollToBottom(!wasFirstLoad);
    }
  }, [allMessages, scrollToBottom]);

  // ── Presence header decoration ─────────────────────────────────────────────
  // Member list, reachable from inside the room (not just from the topic's
  // own detail screen) — reuses TopicMembersScreen wholesale rather than a
  // second member-list surface. DM rooms skip this: the "members" are
  // already the two people named in the header (see `kind` above).
  const openMembers = useCallback(() => {
    (navigation as unknown as { navigate: (name: string, params: unknown) => void }).navigate(
      'TopicsTab',
      { screen: 'TopicMembers', params: { topicId } },
    );
  }, [navigation, topicId]);

  useEffect(() => {
    navigation.setOptions({
      title: topicTitle,
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {/* The claim, once its sentence has withdrawn. This control is the
              part that must NEVER go away: a lock for a room the service
              cannot read, a warning-coloured info mark for one it can, so the
              two rooms never look alike even to someone who let the sentence
              expire without reading it. Tapping it says the sentence again. */}
          <TouchableOpacity
            onPress={() => setClaimOpen((open) => !open)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityState={{ expanded: claimOpen }}
            accessibilityLabel={t(`openstoa.chat.tierClaim.${claim}`)}
            testID="chat-tier-claim-button"
            style={{ marginRight: 10 }}
          >
            <Feather
              name={claim === 'e2ee' ? 'lock' : 'info'}
              size={18}
              color={claim === 'e2ee' ? colors.brand.accent : colors.status.warning}
            />
          </TouchableOpacity>
          {kind !== 'dm' ? (
            <TouchableOpacity
              onPress={openMembers}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t('openstoa.members.viewMembers')}
              style={{ marginRight: 4 }}
            >
              <Feather name="users" size={20} color={colors.text.primary} />
            </TouchableOpacity>
          ) : null}
          {/* Per-topic push mute (P-S). Renders nothing until its state loads. */}
          <TopicMuteButton topicId={topicId} />
          {presence ? (
            <View style={styles.presenceBadge}>
              {/* Green while the stream is open, grey while it is not. This is
                  where the connection state lives now that the bar above the
                  list is gone: a dot is the same 7px either way, so it can
                  never move the conversation. */}
              <View style={[styles.presenceDot, status !== 'open' && styles.presenceDotOffline]} />
              <Text style={styles.presenceCount}>{presence.count}</Text>
            </View>
          ) : null}
        </View>
      ),
    });
  }, [
    navigation,
    topicTitle,
    topicId,
    kind,
    openMembers,
    presence,
    claim,
    claimOpen,
    colors.text.primary,
    colors.brand.accent,
    colors.status.warning,
    t,
    styles.presenceBadge,
    styles.presenceDot,
    styles.presenceCount,
  ]);

  // ── Scroll handler: history pagination + near-bottom tracking ─────────────
  const onScrollTop = useCallback(
    ({
      nativeEvent,
    }: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const offsetY = nativeEvent.contentOffset.y;
      const contentH = nativeEvent.contentSize.height;
      const layoutH = nativeEvent.layoutMeasurement.height;
      // "Near bottom" = within 120 px of the floor. Used to gate the
      // onContentSizeChange auto-scroll so it doesn't fight the user
      // when they've scrolled up to read history.
      userNearBottomRef.current = contentH - offsetY - layoutH < 120;
      // History pagination trigger
      if (offsetY < 80 && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  // ── Push preview (design §13.6 strategy A) ────────────────────────────────
  // Seal a TAK copy of the body and mirror that TAK into the shared iOS Keychain
  // group, so the Notification Service Extension can decrypt the preview without
  // touching the MLS ratchet (which would desync this device). Must ride along in
  // the POST — push fan-out happens there, before archiveOnSend uploads anything.
  // Entirely best-effort: any failure just sends without it.
  const buildPushArchive = useCallback(async (text: string) => {
    if (!topicId) return undefined;
    const seal = await tak.sealForPush(topicId, text, tierRef.current).catch(() => null);
    if (!seal) return undefined;
    void mirrorTakToSharedKeychain(topicId, seal.takVersion, seal.takB64, host).catch(() => {});
    return { ct: seal.ct, takVersion: seal.takVersion };
  }, [tak, topicId, host]);

  // ── Send message ──────────────────────────────────────────────────────────
  /**
   * Put the message on screen FIRST, then send it.
   *
   * The composer clears and the bubble appears in the same frame, because that
   * is the only thing the sender is waiting to see. Sealing and the round trip
   * happen behind it. The button no longer reports progress: the outcome worth
   * reporting is failure, and the row itself reports that, with retry and
   * discard beside it.
   */
  const deliver = useCallback(
    async (pendingId: string, text: string) => {
      try {
        const sealed = await mls.seal(topicId, text);
        /*
         * An attachment gets a push preview like anything else (P-1).
         *
         * It used to be omitted here, because the preview is a copy of the BODY
         * and an attachment's body is an envelope — so the notification read as
         * a line of JSON. That removed the preview instead of teaching the
         * handler to read it, and it did not even work: the SDK sends the copy
         * for attachments too, so agent-sent pictures produced exactly the JSON
         * notification this omission was avoiding. The handlers now parse the
         * envelope and show a caption (iOS additionally fetches and attaches the
         * picture) — see `proofport-app/ios/OpenStoaNSE/ChatMediaEnvelope.swift`
         * and `OpenStoaPushHandler.kt`, both pinned to `chatMedia.ts` by
         * `nativeChatMediaConstants.test.ts`.
         *
         * `media` is still parsed here: the claim call below needs its key.
         */
        const media = parseChatMediaBody(text);
        const pushArchive = await buildPushArchive(text);
        const res = await client.post<{ message: ChatMessage }>(`/api/topics/${topicId}/chat`, {
          ciphertext: sealed.ciphertext,
          epoch: sealed.epoch,
          ...(pushArchive ? { pushArchive } : {}),
        });
        if (!res?.message?.id) throw new Error('no message id');
        // Swap the provisional row for the stored one IN PLACE, so the bubble
        // does not jump: same position, real id, no longer pending.
        setSentMessages((curr) =>
          curr.map((m) => (m.id === pendingId ? { ...res.message, message: text } : m)),
        );
        // The message is out, so the failed row it may have come from is done.
        void forgetFailedMedia(pendingId);
        // Cache own plaintext so it survives a restart (sender can't self-decrypt).
        void mls.cachePlaintext(topicId, res.message.id, text);
        // Re-encrypt for the archive so later members can read it (Phase 3).
        void tak.archiveOnSend(topicId, res.message.id, text, tierRef.current).catch(() => {});
        // Only NOW is the object referenced by a real message, so only now may
        // the unclaimed collector leave it alone.
        if (media) void client.claimChatMedia(topicId, media.key).catch(() => {});
      } catch {
        // The text stays in the bubble, never back in the composer — the reader
        // decides whether to resend or drop it.
        setSentMessages((curr) =>
          curr.map((m) => (m.id === pendingId ? { ...m, pending: false, failed: true } : m)),
        );
      }
    },
    [mls, tak, client, topicId, buildPushArchive, forgetFailedMedia],
  );

  const send = useAuthGuardedAction(async () => {
    const text = draft.trim();
    if (!text || !topicId) return;
    setDraft('');
    const pendingId = nextPendingId();
    setSentMessages((curr) => [
      ...curr,
      {
        id: pendingId,
        message: text,
        userId: sessionUserId ?? '',
        nickname: '',
        createdAt: new Date().toISOString(),
        type: 'message',
        pending: true,
      } as LocalMessage,
    ]);
    await deliver(pendingId, text);
  });

  /** Send it again under the SAME row, so the message keeps its place. */
  const retryFailed = useCallback(
    (msg: LocalMessage) => {
      setSentMessages((curr) =>
        curr.map((m) => (m.id === msg.id ? { ...m, failed: false, pending: true } : m)),
      );
      const envelope = parseChatMediaBody(msg.message ?? '');
      if (!envelope) {
        void deliver(msg.id, msg.message ?? '');
        return;
      }
      /*
       * A restored row can outlive its bytes: an unclaimed attachment is
       * collected an hour after upload. Re-sending regardless would post a
       * message pointing at nothing, so this asks first. Checked rather than
       * inferred from the row's age — the collector is request-triggered, so an
       * object may well outlive the window.
       */
      void (async () => {
        try {
          /*
           * A full download to check existence, because the read route has no
           * cheaper answer — it is a GET or nothing. It costs one temporary
           * file, which `downloadCiphertext` removes either way, and it only
           * runs when somebody presses Retry on a failed attachment.
           */
          await downloadCiphertext({
            fs: hostAttachmentFs(),
            spec: await client.chatMediaFetchSpec(topicId, envelope.key),
            mediaId: envelope.mediaId,
          });
        } catch {
          setSentMessages((curr) =>
            curr.map((m) =>
              m.id === msg.id ? { ...m, pending: false, failed: true, mediaExpired: true } : m,
            ),
          );
          return;
        }
        await deliver(msg.id, msg.message ?? '');
      })();
    },
    [deliver, client, topicId],
  );

  const discardFailed = useCallback(
    (msg: LocalMessage) => {
      setSentMessages((curr) => curr.filter((m) => m.id !== msg.id));
      /*
       * Dropping the row is not enough for an attachment: its bytes are on the
       * server and nothing else will ever name them. The M-1 collector would
       * take it after the grace window, but an hour of paid storage for a
       * message the user just cancelled is a leak with a timer.
       */
      if (msg.mediaKey) void client.deleteChatMedia(topicId, msg.mediaKey).catch(() => {});
      void forgetFailedMedia(msg.id);
    },
    [client, topicId, forgetFailedMedia],
  );

  // ── Image attach helpers ──────────────────────────────────────────────────
  /**
   * Attach an image — encrypted end to end (R-3).
   *
   * It used to hand the raw file to `/api/upload`, which stored it at a public
   * unauthenticated URL and sealed only that URL string: the message was
   * encrypted and the picture inside it was not. Now the bytes are sealed on
   * this device under the topic's TAK and only the ciphertext leaves it.
   *
   * Takes base64, not a URI, because encryption needs the BYTES — the picker
   * and the clipboard both hand us base64 already, so nothing extra is read.
   */
  /*
   * The raw worker, returning a REAL promise.
   *
   * `useAuthGuardedAction` deliberately fires and forgets — it returns `void`
   * and does `void fn(...)` inside — which is right for a button press and
   * wrong for a caller that has to send several attachments one after another:
   * awaiting the guarded wrapper returns instantly, so a "sequential" loop
   * would in fact launch every upload at once, holding every multi-megabyte
   * buffer simultaneously and landing the messages in whatever order the
   * uploads happened to finish. Callers that need ordering take this; callers
   * that are a single button press take the guarded one below.
   */
  const uploadOne = useCallback(async (input: { base64: string; mime: string; filename?: string }) => {
    if (!topicId) return;
    setUploading(true);
    try {
      const bytes = base64ToBytes(input.base64);
      /*
       * The BYTES decide the type. `asset.mimeType` is optional on the picker
       * and the clipboard's data URI can be anything, so trusting either one
       * risks shipping a PNG labelled JPEG — which the reader then renders as
       * the type it was told, not the type it is.
       */
      const mime = resolveChatMediaMime(bytes, input.mime, input.filename);
      if (!mime) throw new ChatMediaError('unsupported-type');
      await sendEncryptedChatMedia(
        { bytes, mime },
        {
          seal: (mediaId, plain) => tak.sealMedia(topicId, mediaId, plain, tierRef.current),
          upload: (ciphertext, mediaId) => client.uploadChatMedia(topicId, mediaId, ciphertext),
          send: async (body) => {
            const sealed = await mls.seal(topicId, body);
            /*
             * No push preview for an attachment: the preview is a copy of the
             * BODY, and this body is an envelope, so the recipient's
             * notification would read as a line of JSON.
             */
            const res = await client.post<{ message: ChatMessage }>(`/api/topics/${topicId}/chat`, {
              ciphertext: sealed.ciphertext,
              epoch: sealed.epoch,
            });
            if (!res?.message?.id) return;
            setSentMessages((curr) =>
              curr.some((m) => m.id === res.message.id) ? curr : [...curr, { ...res.message, message: body }],
            );
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void mls.cachePlaintext(topicId, res.message.id, body);
            // Re-encrypt the ENVELOPE for the archive so later members can read
            // it (Phase 3) — the bytes it points at use the same key.
            void tak.archiveOnSend(topicId, res.message.id, body, tierRef.current).catch(() => {});
          },
          discard: (key) => client.deleteChatMedia(topicId, key),
          claim: (key) => client.claimChatMedia(topicId, key),
          // The bytes stay put when only the SEND fails, so the failed row can
          // retry them. Re-picking a photo costs more on a phone than anywhere
          // else, and a dropped connection mid-send is the COMMON failure here.
          retainForRetry: true,
        },
      );
    } catch (err: unknown) {
      /*
       * WHERE the failure is reported depends on whether a message exists yet.
       *
       * Before the bytes are stored — an unsupported file, no room key, a
       * refused upload — there is nothing in the conversation to attach the
       * failure to, so it is an alert next to the action that caused it.
       *
       * Once the object is stored the failure is about a MESSAGE, and it takes
       * a row in the conversation with Retry and Discard, exactly as a failed
       * text does. Same line the web draws.
       */
      const stored = err instanceof ChatMediaError && err.reason === 'send-failed' ? err.envelope : undefined;
      if (stored) {
        const rowId = nextPendingId();
        const body = buildChatMediaBody(stored);
        // Written BEFORE the row is drawn: the OS can kill this process between
        // the two, and losing it there is precisely what this fixes.
        void (async () => {
          await writeFailedMedia(
            addFailedMedia(await readFailedMedia(), { rowId, body, key: stored.key, createdAt: Date.now() }),
          );
        })();
        setSentMessages((curr) => [
          ...curr,
          {
            id: rowId,
            message: body,
            userId: sessionUserId ?? '',
            nickname: '',
            createdAt: new Date().toISOString(),
            type: 'message',
            failed: true,
            mediaKey: stored.key,
          } as LocalMessage,
        ]);
        return;
      }
      // One sentence per reason. "Upload failed: <stack noise>" told the sender
      // nothing about which of six things went wrong.
      const message =
        err instanceof ChatMediaError
          ? // `limit` is interpolated so the sentence cannot drift from the
            // constant again — it used to say 10MB while the transport refused
            // anything over ~7.4MB.
            t(`openstoa.chat.media.error.${err.reason}`, {
              limit: Math.floor(MAX_CHAT_MEDIA_BYTES / (1024 * 1024)),
            })
          : err instanceof Error
            ? err.message
            : String(err);
      Alert.alert(t('openstoa.chat.media.title'), message);
    } finally {
      setUploading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, t]);

  /** Single-shot callers (the clipboard) — one press, one attachment. */
  const uploadAndSend = useAuthGuardedAction(uploadOne);

  const pickFromLibrary = useAuthGuardedAction(async () => {
    const ImagePicker = loadImagePicker();
    if (!ImagePicker) {
      Alert.alert('Image picker unavailable', 'The host app needs to be rebuilt to include expo-image-picker.');
      return;
    }
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
      /*
       * Several at once, which is what every other chat app allows and what
       * this screen refused for no recorded reason — the single-asset read
       * below was simply never widened.
       *
       * The ceiling is about MEMORY, not taste. `base64: true` makes the picker
       * return the ENCODED bytes for EVERY selected asset in one result, so the
       * whole selection is resident before the first one is sent: at the
       * ~9.5MB-per-image cap that is ~12.7MB of string each, so ten is ~127MB
       * held at once on a phone. Sending is sequential regardless.
       *
       * This is the last base64 left on the send path — the upload itself now
       * hands raw octets to the transport — and it is why the count did not
       * rise when the cap did.
       */
      allowsMultipleSelection: true,
      selectionLimit: MAX_ATTACHMENTS_PER_PICK,
      /*
       * The bytes, not just a URI: the file is encrypted on this device, and
       * `fetch`-ing a `file://` URI is not dependable in React Native.
       *
       * Still base64 because that is the only shape the PICKER offers. The
       * host's filesystem could read the asset as bytes instead (the download
       * path already does, see `lib/chatMediaFiles.ts`), which would remove the
       * last encode on this path and the memory bound above with it — but the
       * fallback for a host binary without that module would need `base64` set
       * anyway, so it is a change with its own edge cases rather than a
       * one-liner.
       */
      base64: true,
      // iOS hands over the ORIGINAL representation by default, which for a
      // photo taken on any recent iPhone is HEIC — a format no browser can
      // decode. The old flow survived that because the server transcoded it;
      // an encrypted upload cannot be transcoded by anyone but the sender, so
      // ask the picker for a compatible representation up front. Guarded: the
      // enum is iOS-only and absent on older picker versions.
      ...(ImagePicker.UIImagePickerPreferredAssetRepresentationMode
        ? {
            preferredAssetRepresentationMode:
              ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
          }
        : {}),
    });
    if (result.canceled || result.assets.length === 0) return;

    // Sequencing and per-asset failure isolation live in `sendPickedAssets`,
    // where they can be tested — the picker is a native module this package
    // does not install, so nothing that drove it here could run.
    // `uploadOne`, not the guarded wrapper: this loop depends on each send
    // actually completing before the next begins.
    await sendPickedAssets(result.assets, uploadOne, () => {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.error.empty'));
    });
  });

  const pasteFromClipboard = useCallback(async () => {
    const Clipboard = loadClipboard();
    if (!Clipboard) {
      Alert.alert('Clipboard unavailable', 'The host app needs to be rebuilt to include the clipboard native module.');
      return;
    }
    const hasImage = await Clipboard.hasImage();
    if (!hasImage) {
      Alert.alert('No image in clipboard');
      return;
    }
    // `data:<mime>;base64,<payload>` — split rather than re-read: the payload
    // is already the bytes the encrypt step needs.
    const dataUri = await Clipboard.getImage();
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri ?? '');
    if (!match) {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.error.unsupported-type'));
      return;
    }
    await uploadAndSend({ base64: match[2], mime: match[1] });
  }, [uploadAndSend, t]);

  const openAttachSheet = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Photo library', 'Paste from clipboard'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) pickFromLibrary();
          else if (buttonIndex === 2) pasteFromClipboard();
        },
      );
    } else {
      Alert.alert('Attach image', undefined, [
        { text: 'Photo library', onPress: pickFromLibrary },
        { text: 'Paste from clipboard', onPress: pasteFromClipboard },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [pickFromLibrary, pasteFromClipboard]);

  // ── Render ────────────────────────────────────────────────────────────────
  const isFirstLoad = historyStatus === 'pending';

  return (
    <>
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      /*
       * `automaticOffset`, NOT a hand-tuned `keyboardVerticalOffset`.
       *
       * Every avoiding-view of this shape compares the view's own frame
       * against the keyboard's frame — and those are two different
       * coordinate spaces. The frame comes from `onLayout`, which reports a
       * position relative to the PARENT; the keyboard reports a position in
       * the window. `keyboardVerticalOffset` exists purely to bridge that
       * gap by hand ("distance between the top of the user screen and the
       * React Native view"), which means the number is only ever right for
       * one nesting. This screen sits under the mini-app's JS header, inside
       * the mini-app tab navigator, inside the HOST tab navigator — and the
       * number has now been reported wrong in both directions: 88 was removed
       * in e537932 for leaving a gap above the keyboard, and the 0 that
       * replaced it hid the composer behind the keyboard entirely, which is
       * the bug this replaces. Nobody has been able to derive the right
       * constant from the source twice running, which is the argument for not
       * having one.
       *
       * `automaticOffset` asks the native side for the view's true position
       * in the window (`viewPositionInWindow`), so the padding is the ACTUAL
       * overlap with the keyboard whatever the ancestry, and nobody has to
       * keep a header height in sync here. Same package, same provider
       * (mounted at the host root in proofport-app/App.tsx) that
       * PostDetailScreen and PostCreateScreen already dock their composers
       * with.
       *
       * Android is deliberately untouched: `behavior` stays undefined there
       * because the activity is `adjustResize`, which already moves the
       * window, and adding padding on top would double-count.
       */
      automaticOffset
      keyboardVerticalOffset={0}
    >
      {/* What this room is, said in the room. The mini-app had no such line at
          all: the one property that distinguishes this chat from every other
          one was invisible here, and in a public topic the opposite property —
          that the service CAN read it — was invisible too.

          PRESENT TENSE ("new messages and images are…"): images sent before the
          encrypted-attachment change are still plaintext objects, so a claim
          about the room would be false about its own history. */}
      {claimOpen ? (
      <View
        style={[styles.tierBanner, claim === 'serverReadable' && styles.tierBannerReadable]}
        accessibilityRole="summary"
        testID="chat-tier-banner"
      >
        <Text
          style={[styles.tierBannerText, claim === 'serverReadable' && styles.tierBannerTextReadable]}
        >
          {t(`openstoa.chat.tierClaim.${claim}`)}
        </Text>
        {tiersUrl ? (
          <Text
            style={styles.tierBannerLink}
            accessibilityRole="link"
            // In-app WebView, never Linking.openURL — the mini-app keeps its
            // own back stack (project-wide rule for every http(s) link).
            onPress={() => navigation.navigate('InAppBrowser', { url: tiersUrl })}
          >
            {t('openstoa.chat.tierClaim.learnMore')}
          </Text>
        ) : null}
      </View>
      ) : null}

      {/*
        Locked rows, explained, with the one thing that resolves them.

        Previously this room rendered a column of "Encrypted — this device has
        no key for it" and left it there: true, useless, and reading like
        breakage. The key IS still coming — an existing member's client hands it
        over and this room asks again on every tick — so the wait is named, and
        so is the action, because for someone's own second device the remedy is
        entirely in their hands.
      */}
      {awaitingRoomKey ? (
        <View
          style={styles.keyWaitNotice}
          // `status`, not `alert`: nothing is wrong and nothing is urgent — the
          // keys are on their way, and an alert would interrupt to say so.
          accessibilityRole="progressbar"
          testID="chat-key-wait"
        >
          <WaitingStatus
            label={t('openstoa.chat.awaitingKey.body', { count: lockedCount })}
            color={colors.brand.accent}
            style={styles.keyWaitText}
            testID="chat-key-wait-line"
          />
          <Text style={styles.keyWaitHint}>{t('openstoa.chat.awaitingKey.hint')}</Text>
        </View>
      ) : null}

      {/* No connection bar here.
          It appeared and disappeared above the list, so every blink of the
          stream — a phone changing network, a screen waking — pushed the whole
          conversation down and back. The live state is the coloured dot in the
          header, which cannot change the layout, and a connection that stays
          down for OFFLINE_NOTICE_AFTER_MS raises the dialog below. */}

      {/* Message list.
          `syncing` counts as first load: on a device that has just joined,
          every row is sealed until the room key lands, so a list is the wrong
          thing to draw. One spinner in the middle, and the messages when they
          are readable. */}
      {isFirstLoad || syncing ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={visibleMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <ChatMessageRow
              item={item}
              onRetry={retryFailed}
              onDiscard={discardFailed}
              syncing={syncing}
              awaitingKey={awaitingRoomKey}
              prevItem={index > 0 ? visibleMessages[index - 1] : undefined}
              styles={styles}
              navigation={navigation}
              client={client}
              onImagePress={(uri, save) => setImageViewer({ uri, save })}
              onAuthorPress={setProfileTarget}
              onLongPress={(text) => setActionTarget(copyTargets(text))}
              topicId={topicId}
              tier={tier}
            />
          )}
          contentContainerStyle={styles.listContent}
          onScroll={onScrollTop}
          scrollEventThrottle={64}
          // Only auto-scroll when the user is already pinned to the
          // bottom. This covers async-grown content (OG card resolving,
          // inline images loading) without yanking the viewport away
          // from someone scrolled up reading older messages.
          onContentSizeChange={() => {
            if (userNearBottomRef.current) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={
            isFetchingNextPage ? (
              <View style={styles.loadingMore}>
                <ActivityIndicator size="small" color={colors.brand.primary} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>{t('openstoa.chat.noMessagesYet')}</Text>
            </View>
          }
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        />
      )}

      <OfflineNotice offline={status !== 'open'} styles={styles} />

      {/* Input bar */}
      <View style={styles.inputRow}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={openAttachSheet}
          disabled={uploading}
          activeOpacity={0.7}
        >
          {uploading ? (
            <ActivityIndicator size="small" color={colors.text.primary} />
          ) : (
            <Text style={styles.attachLabel}>+</Text>
          )}
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder={t('openstoa.chat.messagePlaceholder')}
          placeholderTextColor={colors.text.tertiary}
          value={draft}
          onChangeText={setDraft}
          // NOT disabled while sending. Toggling `editable` blurs the input,
          // which drops the keyboard — and messages come in bursts of two or
          // three, so the keyboard has to survive a send.
          multiline
          // Return inserts a newline; the Send button is the only way to send.
          // `default` is the honest return key for that — `"send"` would label
          // a key that does not send. There is deliberately no
          // `onSubmitEditing`: a `multiline` TextInput never raises it on iOS,
          // and `blurOnSubmit={false}` suppresses it on Android too, so wiring
          // `send` there would be a line that looks live and is not.
          returnKeyType="default"
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, !draft.trim() && styles.sendButtonDisabled]}
          onPress={send}
          disabled={!draft.trim()}
          activeOpacity={0.7}
        >
          {/* No busy state. The bubble is on screen the moment Send is pressed,
              and the only outcome worth reporting is failure — which the row
              itself reports. A spinner here asks the reader to wait for
              something they already watched finish. */}
          <Text style={styles.sendLabel}>{t('openstoa.chat.send')}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
    <MessageActionSheet target={actionTarget} styles={styles} onClose={() => setActionTarget(null)} />
    <ImageViewerModal
      url={imageViewer?.uri ?? null}
      onClose={() => setImageViewer(null)}
      onSave={imageViewer?.save}
      saveLabel={t('openstoa.chat.media.save')}
    />
    <PeerProfileCard
      target={profileTarget}
      viewerUserId={sessionUserId}
      onClose={() => setProfileTarget(null)}
      onMessage={openDmFromProfile}
      messagePending={startDmMutation.isPending}
    />
    </>
  );
}

// ---------------------------------------------------------------------------
// ChatMessageRow
// ---------------------------------------------------------------------------

type Styles = ReturnType<typeof makeStyles>;

interface RowProps {
  item: LocalMessage;
  prevItem?: LocalMessage;
  onRetry: (msg: LocalMessage) => void;
  onDiscard: (msg: LocalMessage) => void;
  styles: Styles;
  navigation: NativeStackNavigationProp<ChatStackParamList>;
  client: ReturnType<typeof useOpenStoaClient>;
  /** `save` is present only for attachments this device decrypted itself. */
  onImagePress: (uri: string, save?: () => void) => void;
  onAuthorPress: (target: PeerProfileTarget) => void;
  /** The room this row belongs to — an encrypted attachment is fetched per topic. */
  topicId: string;
  /** Tier, which selects the TAK an attachment was sealed under. NOT the topic's
   *  visibility: a DM row says `'secret'` and its attachments use the DM root. */
  tier: ChatTier;
  /** Long-press on the bubble — opens the copy sheet with the message as sent. */
  onLongPress: (text: string) => void;
  /** The room key has not reached this device YET — locked rows are loading,
   *  not broken, and must not be dressed as a permanent failure. */
  syncing?: boolean;
  /** A key is still expected — see `awaitingRoomKey` in the screen. */
  awaitingKey?: boolean;
}

// One line per distinct author, not per row: this renders inside a list.
const _ownershipReported = new Set<string>();
function reportOwnershipMismatch(messageUserId: string | null | undefined, sessionUserId: string | null): void {
  const key = `${messageUserId}|${sessionUserId}`;
  if (_ownershipReported.has(key)) return;
  _ownershipReported.add(key);
  // Through the server sink, not console.log: Hermes console output never
  // reaches a release build's device log, which is why the first attempt at
  // this diagnostic produced nothing at all.
  report('chat/ownership', {
    message: messageUserId ?? null,
    session: sessionUserId,
    equal: messageUserId === sessionUserId,
    sameIgnoringCase: (messageUserId ?? '').toLowerCase() === (sessionUserId ?? '').toLowerCase(),
  });
}

function ChatMessageRow({ item, prevItem, styles, navigation, client, onImagePress, onAuthorPress, syncing, awaitingKey, onRetry, onDiscard, onLongPress, topicId, tier }: RowProps) {
  const sessionUserId = useOpenStoaSession((s) => s.userId);

  // System messages (join / leave only — every other type renders as a
  // regular message bubble below). The previous code did `type !==
  // 'message' ? 'joined' : 'left'` which incorrectly rendered every
  // non-'message' / non-'join' row (including 'ai') as "left the room"
  // and dropped the body entirely.
  if (item.type === 'join' || item.type === 'leave') {
    const verb = item.type === 'join' ? 'joined' : 'left';
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemMsg}>
          {item.nickname} {verb} the room
        </Text>
      </View>
    );
  }

  // Group: same author AND within 60 seconds of previous message. Only
  // applies when both rows are bubble-renderable (i.e. not join/leave).
  const prevIsBubble =
    !!prevItem && prevItem.type !== 'join' && prevItem.type !== 'leave';
  const sameAuthor =
    prevIsBubble &&
    prevItem!.userId === item.userId &&
    Math.abs(
      new Date(item.createdAt).getTime() -
        new Date(prevItem!.createdAt).getTime(),
    ) <= 60_000;

  // A provisional row is mine by construction — it has not been near the server
  // yet, so there is no userId to compare. Deciding by comparison alone put the
  // bubble on the LEFT until the server answered, then slid it right.
  const isOwn = item.pending || item.failed ? true : item.userId === sessionUserId;
  // Own messages render as someone else's on device, and the two candidate
  // causes — a session with no userId, or ids that differ in shape — are
  // indistinguishable from the outside. Log the comparison ONCE per mismatched
  // author so the console names the cause instead of another guess.
  reportOwnershipMismatch(item.userId, sessionUserId);

  return (
    <MessageBody
      item={item}
      onRetry={onRetry}
      onDiscard={onDiscard}
      onLongPress={onLongPress}
      syncing={syncing}
      awaitingKey={awaitingKey}
      sameAuthor={sameAuthor}
      isOwn={isOwn}
      styles={styles}
      navigation={navigation}
      client={client}
      onImagePress={onImagePress}
      onAuthorPress={onAuthorPress}
      topicId={topicId}
      tier={tier}
    />
  );
}

/**
 * Says the connection is down, once it has been down long enough to matter.
 *
 * A bar above the composer, not a dialog. The stream blinks routinely on a
 * phone — a network handover, a screen wake — and the reader has nothing to
 * decide when it does: the client reconnects on its own, and sending still
 * works here, because a send is a plain HTTP request rather than part of the
 * stream. Taking the screen to say so would interrupt without offering anything
 * to do about it.
 *
 * It is absolutely positioned, so showing it moves nothing. The bar the old
 * build put ABOVE the list pushed the whole conversation down and back on every
 * blink.
 */
const OFFLINE_NOTICE_AFTER_MS = 10_000;

function OfflineNotice({ offline, styles }: { offline: boolean; styles: Styles }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!offline) {
      // Reconnected: down immediately, and the clock restarts, so a later blip
      // gets its own full ten seconds instead of inheriting these.
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), OFFLINE_NOTICE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [offline]);

  if (!show) return null;
  return (
    <View style={styles.offlineBar} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Text style={styles.offlineBarText} numberOfLines={2}>
        {t('openstoa.chat.offline.body')}
      </Text>
      <TouchableOpacity
        onPress={() => setShow(false)}
        accessibilityLabel={t('openstoa.chat.offline.dismiss')}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.offlineBarDismiss}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

/** The preview slot before (or without) an answer — same box, no content. */
const EMPTY_OG: OGData = { title: null, description: null, image: null, siteName: null, favicon: null };

/**
 * Long-press menu for a message.
 *
 * Copy is the whole feature. Delete is absent on purpose — this client can only
 * forget a message locally, and a "Delete" that leaves it on every other
 * member's screen is a lie whichever way it is worded.
 *
 * A plain Modal rather than ActionSheetIOS, so iOS and Android show the same
 * thing and nothing new is added to the dependency list.
 */
function MessageActionSheet({
  target,
  styles,
  onClose,
}: {
  target: { message: string; link: string | null } | null;
  styles: Styles;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!target) return null;
  const copy = (text: string) => {
    // Same optional-require as the paste path above: the module is absent until
    // a native rebuild ships, and a missing clipboard must not crash the room.
    loadClipboard()?.setString(text);
    onClose();
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.sheet}>
          <TouchableOpacity style={styles.sheetItem} onPress={() => copy(target.message)}>
            <Text style={styles.sheetItemText}>{t('openstoa.chat.copyMessage')}</Text>
          </TouchableOpacity>
          {target.link ? (
            <TouchableOpacity style={styles.sheetItem} onPress={() => copy(target.link!)}>
              <Text style={styles.sheetItemText}>{t('openstoa.chat.copyLink')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// MessageBody — handles URL detection, OG fetch, and link tapping
// ---------------------------------------------------------------------------

interface MessageBodyProps {
  item: LocalMessage;
  onRetry: (msg: LocalMessage) => void;
  onDiscard: (msg: LocalMessage) => void;
  onLongPress: (text: string) => void;
  sameAuthor: boolean;
  isOwn: boolean;
  styles: Styles;
  navigation: NativeStackNavigationProp<ChatStackParamList>;
  client: ReturnType<typeof useOpenStoaClient>;
  /** `save` is present only for attachments this device decrypted itself. */
  onImagePress: (uri: string, save?: () => void) => void;
  onAuthorPress: (target: PeerProfileTarget) => void;
  /** The room this row belongs to — an encrypted attachment is fetched per topic. */
  topicId: string;
  /** Tier, which selects the TAK an attachment was sealed under. NOT the topic's
   *  visibility: a DM row says `'secret'` and its attachments use the DM root. */
  tier: ChatTier;
  /** The room key has not reached this device YET — see `syncing` in the screen. */
  syncing?: boolean;
  /** A key is still expected — see `awaitingRoomKey` in the screen. */
  awaitingKey?: boolean;
}

// Image URLs: explicit extension OR a known image host. `media.zkproofport.app`
// is the R2 bucket used by `client.uploadFile()` for chat images, so URLs
// from there are always images even when the extension is mangled.
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i;
function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('media.zkproofport.app')) return true;
  } catch { /* not a URL */ }
  return false;
}

/**
 * One end-to-end encrypted attachment: fetch the ciphertext, decrypt it on the
 * device, show the picture.
 *
 * Three failures, three sentences. They mean different things to the reader —
 * "the key has not reached this device yet, it may still arrive", "the fetch
 * failed, try again", and "these bytes are not what the message says they are,
 * retrying will not help" — and one placeholder for all three says none of it.
 */
function EncryptedAttachment({
  envelope,
  topicId,
  tier,
  client,
  styles,
  isOwn,
  onImagePress,
}: {
  envelope: ChatMediaEnvelope;
  topicId: string;
  tier: ChatTier;
  client: ReturnType<typeof useOpenStoaClient>;
  styles: Styles;
  isOwn: boolean;
  /** Opens the full-screen viewer. The decrypted bytes never leave the device. */
  onImagePress: (uri: string, save?: () => void) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ChatMediaLoad | null>(null);
  /**
   * `file://` for the decrypted picture, NOT a `data:` URI.
   *
   * Re-encoding the plaintext to base64 for a URI cost 694ms of a measured
   * 3982ms on a 6MB attachment under Hermes, and then kept a ~13MB string alive
   * for as long as the row was on screen. `<Image>` reads a file perfectly
   * well, and the bytes are already bytes.
   */
  const [fileUri, setFileUri] = useState<string | null>(null);
  /** The same file, kept so it can be deleted and re-read for a save. */
  const fileRef = useRef<AttachmentFile | null>(null);
  /** Bumped by the retry button; re-runs the effect without remounting the row. */
  const [attempt, setAttempt] = useState(0);
  const { key, mediaId, takVersion, mime, size } = envelope;

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setFileUri(null);
    void (async () => {
      const tak = getTakSessionStore(client);
      const res = await loadEncryptedChatMedia(
        { v: 1, key, mediaId, takVersion, mime, size },
        {
          /*
           * Downloaded by the NATIVE filesystem, straight to disk.
           *
           * Not `fetch` — RN's `Response.arrayBuffer()` is not dependable
           * (facebook/react-native#6743) because only strings cross the bridge,
           * which is why this used to ask the server for base64-in-JSON and
           * decode a multi-megabyte string here. A throw becomes `fetch-failed`,
           * which is retryable and has a Reload control.
           */
          fetchCiphertext: async (objectKey) =>
            downloadCiphertext({
              fs: hostAttachmentFs(),
              spec: await client.chatMediaFetchSpec(topicId, objectKey),
              mediaId,
            }),
          open: (id, version, ciphertext) => tak.openMedia(topicId, id, version, ciphertext, tier),
        },
      );
      if (cancelled) return;
      if (res.status === 'ok') {
        const file = writeDecrypted({ fs: hostAttachmentFs(), bytes: res.bytes, mime: res.mime, mediaId });
        fileRef.current = file;
        setFileUri(file?.uri ?? null);
      }
      setState(res);
    })();
    return () => {
      cancelled = true;
      /*
       * The plaintext copy goes with the row.
       *
       * It is a decrypted picture from an end-to-end encrypted conversation
       * sitting in a cache directory, so leaving it behind is not merely
       * untidy — it is the one file in this flow that the encryption exists to
       * prevent from lasting. The OS may reclaim the cache eventually; that is
       * not a schedule worth relying on.
       */
      discardDecrypted(fileRef.current);
      fileRef.current = null;
    };
  }, [client, topicId, tier, key, mediaId, takVersion, mime, size, attempt]);

  /*
   * Hand the decrypted bytes to the share sheet.
   *
   * Read back from the DISPLAY FILE rather than held in a state field: the
   * plaintext is already on disk for `<Image>`, and keeping a second
   * multi-megabyte copy in JS for a button most people never press is exactly
   * the kind of cost this change exists to remove. `saveAttachment` writes its
   * own copy under the tidy filename and deletes it when the sheet closes, so
   * the picture on screen is untouched.
   */
  const saveThis = useCallback(async () => {
    const file = fileRef.current;
    if (!file) {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.saveUnavailable'));
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await file.bytes();
    } catch {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.saveFailed'));
      return;
    }
    const res = await saveAttachment({
      fs: hostAttachmentFs(),
      share: Share,
      bytes,
      mime,
      mediaId,
    });
    if (res.status === 'unavailable') {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.saveUnavailable'));
    } else if (res.status !== 'shared') {
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.saveFailed'));
    } else if (res.outcome === 'saved-to-photos') {
      // Saving worked and said nothing, so the only way to find out was to open
      // Photos. Confirmed for THIS outcome only: a dismissal or a hand-off to
      // another app is not a save, and announcing one would be untrue.
      Alert.alert(t('openstoa.chat.media.title'), t('openstoa.chat.media.saved'));
    }
  }, [mime, mediaId, t]);

  const wrap = isOwn ? styles.bubbleOGWrapOwn : styles.bubbleOGWrapOther;

  if (state === null) {
    return (
      <View style={wrap}>
        <Text style={styles.lockedBody}>{t('openstoa.chat.media.decrypting')}</Text>
      </View>
    );
  }
  if (state.status === 'locked') {
    return (
      <View style={wrap}>
        <Text style={styles.lockedBody}>🔒 {t('openstoa.chat.media.locked')}</Text>
      </View>
    );
  }
  if (state.status === 'fetch-failed') {
    return (
      <View style={wrap}>
        <Text style={styles.lockedBody}>{t('openstoa.chat.media.fetchFailed')}</Text>
        {/* RELOAD, not "Retry": the failed ROW has a Retry of its own, and two
            identical labels on one row are indistinguishable to a reader. */}
        <TouchableOpacity onPress={() => setAttempt((a) => a + 1)}>
          <Text style={styles.sendFailedAction}>{t('openstoa.chat.media.reload')}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (state.status === 'decrypt-failed') {
    return (
      <View style={wrap}>
        <Text style={styles.lockedBody}>{t('openstoa.chat.media.decryptFailed')}</Text>
      </View>
    );
  }
  /*
   * Tapping opens the viewer, the same as a plaintext image.
   *
   * It did not, and that was a regression rather than a decision: R-3 moved
   * attachments behind this component and the `onImagePress` the old inline
   * path used never came with them, so an encrypted picture was the one kind
   * you could not enlarge. Guarded on `dataUri` so the states above — still
   * decrypting, locked, failed — stay inert rather than opening an empty
   * viewer.
   */
  return (
    <View style={wrap}>
      <TouchableOpacity
        activeOpacity={0.85}
        disabled={!fileUri}
        onPress={() => fileUri && onImagePress(fileUri, () => void saveThis())}
        accessibilityRole="imagebutton"
        accessibilityLabel={t('openstoa.chat.media.alt')}
        testID="encrypted-attachment-open"
      >
        {/*
          Sized by the shared rule, not by a fixed square. 220x220 bounded the
          height but center-cropped every ordinary landscape photo to get there.
          See `packages/mls/src/chatMediaLayout.ts`.
        */}
        <ChatImage
          uri={fileUri}
          accessibilityLabel={t('openstoa.chat.media.alt')}
          croppedLabel={t('openstoa.chat.media.cropped')}
          testID="encrypted-attachment-image"
        />
      </TouchableOpacity>
    </View>
  );
}

function MessageBody({ item, sameAuthor, isOwn, styles, navigation, client, onImagePress, onAuthorPress, syncing, awaitingKey, onRetry, onDiscard, onLongPress, topicId, tier }: MessageBodyProps) {
  // Its OWN hook. `t` from the screen component is not in scope here, and
  // reaching for it crashed every room that rendered a locked row.
  const { t } = useTranslation();
  const rawContent: string = item.message ?? '';
  /*
   * A locked row while the key is still coming says so, and only then admits
   * defeat.
   *
   * It used to always read "Encrypted — this device has no key for it": true,
   * final-sounding, and wrong about the situation, because the key is on its
   * way. The notice above carries the explanation and the remedy, so the bubble
   * stays short — it only has to distinguish "not yet" from "not at all".
   */
  const content: string =
    rawContent === '[unable to decrypt]'
      ? t(awaitingKey ? 'openstoa.chat.lockedMessageSyncing' : 'openstoa.chat.lockedMessage')
      : rawContent;
  /*
   * An encrypted attachment, or null for an ordinary message. Memoised so the
   * attachment's decrypt effect does not re-run on every unrelated re-render of
   * the room.
   */
  const mediaEnvelope = useMemo(() => parseChatMediaBody(rawContent), [rawContent]);
  const firstUrl = extractFirstUrl(content);
  const urlOnly = firstUrl !== null && isUrlOnly(content);
  // When the user pastes or uploads an image, the chat message body is just
  // the public URL. Render it as an inline image so it shows up like
  // Telegram/Slack instead of leaking the raw URL as text.
  const imageUrl = urlOnly && firstUrl && isImageUrl(firstUrl) ? firstUrl : null;

  const { data: ogData, isPending: ogPending } = useQuery<OGData | null>({
    queryKey: ['og', firstUrl],
    queryFn: async () => {
      if (!firstUrl) return null;
      try {
        // YouTube short-circuit: hit the official oEmbed endpoint directly
        // from the device. Avoids the server's UA gating and works without
        // a deploy. Other URLs still fall back to the server's /api/og
        // generic scraper.
        let parsed: URL | null = null;
        try {
          parsed = new URL(firstUrl);
        } catch {
          /* not a URL */
        }
        const host = parsed?.hostname ?? '';
        const isYouTube =
          host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
        if (isYouTube) {
          // Deadlined like everything else the person is waiting on. It is a
          // third party rather than our API, which if anything makes it MORE
          // likely to accept a connection and go quiet — and this runs inside a
          // query, so a request that never answers is a preview that spins for
          // the life of the screen. The surrounding catch turns the timeout
          // into "no preview", which is the right outcome for a link card.
          const r = await fetchWithTimeout(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(firstUrl)}&format=json`,
            {},
            { path: 'youtube.com/oembed', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
          );
          if (r.ok) {
            const j = (await r.json()) as {
              title?: string;
              author_name?: string;
              thumbnail_url?: string;
            };
            return {
              title: j.title ?? null,
              description: j.author_name ? `by ${j.author_name}` : null,
              image: j.thumbnail_url ?? null,
              siteName: 'YouTube',
              favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
              url: firstUrl,
            } as OGData;
          }
          // oEmbed failed (private/deleted video etc.) — fall through.
        }
        // Cache-buster to dodge stale iOS HTTP cache from before the
        // server-side OG scraper was redeployed with the new UA + YouTube
        // oEmbed branch. Without this, the device keeps returning the old
        // empty payload that was cached by CFNetwork at status 200.
        const cacheBust = Date.now();
        const res = await client.get<OGData>(
          `/api/og?url=${encodeURIComponent(firstUrl)}&_=${cacheBust}`,
        );
        // Server may return image/favicon as a relative path through our
        // own image proxy (`/api/og/image?src=...`) so the device never
        // talks to flaky upstream CDNs. Resolve to absolute URLs before
        // handing to <Image>.
        const baseUrl = client.getBaseUrl();
        const absolutize = (u: string | null): string | null => {
          if (!u) return u;
          if (u.startsWith('http')) return u;
          if (u.startsWith('/')) return `${baseUrl}${u}`;
          return u;
        };
        if (res) {
          res.image = absolutize(res.image);
          res.favicon = absolutize(res.favicon);
        }
        console.log('[OG] result', { firstUrl, hasTitle: !!res?.title, hasImage: !!res?.image, raw: res });
        return res;
      } catch {
        // No card for this link. The message text is rendered either way, so a
        // site that refuses server-side fetches (reddit answers ours with a
        // 502) costs the preview, never the message.
        return null;
      }
    },
    // Skip OG fetch when the message is just an image URL (we render the
    // image directly) — saves a wasted server hit per image message.
    enabled: firstUrl !== null && !imageUrl,
    staleTime: 60 * 60 * 1000, // 1 hour
    // A link with no preview is the normal outcome for plenty of sites, not a
    // transient error — retrying just repeats a request already answered.
    retry: false,
  });

  const hasOG = ogData != null && (ogData.title != null || ogData.image != null);
  /*
   * The card REPLACES the link text — showing both is the duplication every
   * messenger avoids. But only while a card is actually coming: `/api/og`
   * refuses some sites outright, and a message must never end up with neither.
   */
  const previewUnavailable = !ogPending && !hasOG;
  /** Domain, as the subtitle when the fetch gave us no site name. */
  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return u;
    }
  };

  const openUrl = useCallback(
    (url: string) => navigation.navigate('InAppBrowser', { url }),
    [navigation],
  );

  // Split content into text + link segments
  const segments = useMemo(() => {
    const parts: Array<{ text: string; isUrl: boolean }> = [];
    let lastIndex = 0;
    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: content.slice(lastIndex, match.index), isUrl: false });
      }
      parts.push({ text: match[0], isUrl: true });
      lastIndex = match.index + match[0].length;
    }
    URL_REGEX.lastIndex = 0;
    if (lastIndex < content.length) {
      parts.push({ text: content.slice(lastIndex), isUrl: false });
    }
    return parts;
  }, [content]);

  const timeLabel = formatRelativeTime(item.createdAt);
  // The decrypt sentinel is an INTERNAL marker; it used to reach the bubble
  // verbatim as "[unable to decrypt]", which reads as corruption. While the
  // room key is still on its way this is loading, not failure — say so, and
  // never show the marker itself either way.
  const locked = item.message === '[unable to decrypt]';
  const bodyStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextOther;
  const linkStyle = isOwn ? styles.linkOwn : styles.linkOther;

  return (
    <View style={styles.messageRow}>
      {/* Author name — other users only, first in group. AI members show a
          badge. Tapping opens the peer profile card (design: avatar/name
          tap → card, same as TopicMembersScreen). Grouped follow-up
          messages don't repeat the name, so there's no tap target on them —
          the reader can scroll up to the group header or use the member
          list instead. */}
      {!isOwn && !sameAuthor ? (
        <TouchableOpacity
          style={styles.bubbleAuthorRow}
          activeOpacity={0.6}
          onPress={() =>
            onAuthorPress({
              userId: item.userId,
              nickname: item.nickname,
              profileImage: item.profileImage,
              isAI: item.isAI,
            })
          }
          accessibilityRole="button"
          accessibilityLabel={item.nickname}
        >
          <Text style={styles.bubbleAuthor}>{displayNickname(item.nickname ?? '')}</Text>
          {item.isAI ? <Text style={styles.aiBadge}>AI</Text> : null}
        </TouchableOpacity>
      ) : null}

      {/* Bubble row */}
      <View
        style={[
          styles.bubbleRow,
          isOwn ? styles.bubbleRowOwn : styles.bubbleRowOther,
        ]}
      >
        {/* Send failed: an alert mark and both ways out, outside the bubble on
            the reader's side. The text stays in the bubble rather than jumping
            back into the composer, so nothing the user typed is ever lost. */}
        {item.failed ? (
          <MessageFailedControls
            expired={item.mediaExpired}
            onRetry={() => onRetry(item)}
            onDiscard={() => onDiscard(item)}
            t={t}
            styles={styles}
          />
        ) : null}

        {/* Timestamp left of bubble for own messages */}
        {isOwn && !sameAuthor ? (
          <Text style={[styles.bubbleTime, styles.bubbleTimeOwn]}>{timeLabel}</Text>
        ) : null}

        {/* Encrypted attachment (R-3) — decrypted on this device. */}
        {mediaEnvelope ? (
          <EncryptedAttachment
            envelope={mediaEnvelope}
            topicId={topicId}
            tier={tier}
            client={client}
            styles={styles}
            isOwn={isOwn}
            onImagePress={onImagePress}
          />
        ) : null}

        {/* Inline image — a message sent BEFORE R-3, whose body really is a
            public URL. Kept so pictures already in rooms keep rendering; new
            sends never take this path. */}
        {!mediaEnvelope && imageUrl ? (
          <TouchableOpacity
            activeOpacity={0.85}
            // Open in a local image viewer instead of the in-app WebView —
            // the WebView renders the raw image with a blank page below.
            onPress={() => onImagePress(imageUrl)}
            onLongPress={() => onLongPress(rawContent)}
            delayLongPress={400}
            style={isOwn ? styles.bubbleOGWrapOwn : styles.bubbleOGWrapOther}
          >
            {/* The same rule as the encrypted path, through the same component. */}
            <ChatImage
              uri={imageUrl}
              accessibilityLabel={t('openstoa.chat.media.alt')}
              croppedLabel={t('openstoa.chat.media.cropped')}
              testID="inline-image"
            />
          </TouchableOpacity>
        ) : null}

        {/* The bubble is hidden while the card carries the message: an inline
            image, or a link preview that is on its way or already here. It
            comes back only when there will be no card at all — the condition
            used to be `!hasOG`, which put the raw URL on screen for the whole
            fetch and then took it away, moving everything below it. */}
        {(!urlOnly || previewUnavailable) && !imageUrl && !mediaEnvelope ? (
          <TouchableOpacity
            activeOpacity={1}
            onLongPress={() => onLongPress(rawContent)}
            delayLongPress={400}
            style={[
              styles.bubble,
              isOwn ? styles.bubbleOwn : styles.bubbleOther,
            ]}
          >
            <Text style={locked ? styles.lockedBody : bodyStyle}>
              {segments.map((seg, i) =>
                seg.isUrl ? (
                  <Text
                    key={i}
                    style={[bodyStyle, linkStyle]}
                    onPress={() => openUrl(seg.text)}
                  >
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Timestamp right of bubble for other users */}
        {!isOwn && !sameAuthor ? (
          <Text style={[styles.bubbleTime, styles.bubbleTimeOther]}>{timeLabel}</Text>
        ) : null}
      </View>

      {/* Link preview — a slot of FIXED height, present from the moment we know
          the message has a link and never taller or shorter afterwards.
          Rendering it only once the fetch succeeded made the list jump when a
          card arrived, and jump again when one never did. */}
      {firstUrl && !imageUrl && !mediaEnvelope && !previewUnavailable ? (
        <View style={isOwn ? styles.bubbleOGWrapOwn : styles.bubbleOGWrapOther}>
          <OGPreviewCard
            onLongPress={() => onLongPress(rawContent)}
            url={firstUrl}
            data={hasOG ? ogData! : EMPTY_OG}
            compact
            loading={ogPending}
            host={hostOf(firstUrl)}
            onPress={() => openUrl(firstUrl)}
          />
        </View>
      ) : null}
    </View>
  );
}

