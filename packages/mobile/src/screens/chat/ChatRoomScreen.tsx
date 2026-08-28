import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from '../../api/timeout';
import React, { useSyncExternalStore,
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
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOpenStoaMutation as useMutation } from '../../hooks/useOpenStoaMutation';
import { useTranslation } from 'react-i18next';
import { isOwnMessage } from '../../lib/messageSide';
import Feather from 'react-native-vector-icons/Feather';
import type { ChatMessage } from '@openstoa/api-types';
import { topicKeys, UNREADABLE_BODY } from '@openstoa/api-types';
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
import {
  discardDecrypted,
  downloadCiphertext,
  existingDecrypted,
  writeDecrypted,
} from '../../lib/chatMediaFiles';
import {
  ChatMediaError,
  MAX_ATTACHMENTS_PER_PICK,
  MAX_CHAT_MEDIA_BYTES,
  addFailedRow,
  base64ToBytes,
  buildChatMediaBody,
  isFailedMediaExpired,
  parseFailedRows,
  removeFailedRow,
  serializeFailedRows,
  loadEncryptedChatMedia,
  parseChatMediaBody,
  resolveChatMediaMime,
  sendEncryptedChatMedia,
  type ChatMediaEnvelope,
  type ChatMediaLoad,
  type PersistedFailedRow,
} from '../../lib/chatMedia';
import { rememberSentChatMedia, readSentChatMedia } from '../../lib/chatMediaPlaintextCache';
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
   * Retry was pressed and the attempt is still running.
   *
   * The row stays FAILED throughout, so it keeps its place and its Discard;
   * only Retry is swapped for a spinner. Clearing `failed` for the duration was
   * the obvious move and the wrong one — a send that dies before it reaches the
   * network dies in milliseconds, so the controls vanished and reappeared
   * within a frame and the press read as a dead button.
   */
  retrying?: boolean;
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
import {
  EDGE_REFUSAL_RETRIES,
  edgeRefusalRetryDelayMs,
  isEdgeRefusal,
} from '../../api/openstoaClient';
import { getMlsSessionStore, getTakSessionStore, toDisplayMessageMls, ackDeliveryMls, report } from '../../crypto/mobileTransport';
import {
  mirrorPushSessionToSharedKeychain,
  mirrorTakToSharedKeychain,
} from '../../crypto/sharedKeychainNative';
import type { ArchiveRootState, Visibility } from '../../crypto/takSession';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { useThemeColors } from '../../theme/ThemeContext';
import {
  askStatus,
  askLabelKey,
  askIsPressable,
  tierCanAsk,
  oldestReadableEpoch,
} from '../../lib/keyRequest';
import { chatEmptyLabelKey, chatEmptyReason } from '../../lib/chatEmptyState';
import { getCryptoGeneration, subscribeCryptoGeneration } from '../../crypto/mobileTransport';
import KeyRequestList, { type PendingKeyRequest } from '../../components/KeyRequestList';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { OGPreviewCard } from '../../components/OGPreviewCard';
import type { OGData } from '../../components/OGPreviewCard';
import ImageViewerModal from '../../components/ImageViewerModal';
import { CHAT_IMAGE_SLOT_WIDTH, ChatImage } from '../../components/ChatImage';
// The same rule ChatImage settles on, so a reserved row and the picture that
// lands in it are the same size.
import { chatMediaBox } from '../../lib/chatMediaLayout';
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

/**
 * Exported for `chatRoomKeyWaitLayout.test.tsx`, which asserts that the
 * key-wait notice cannot grow.
 *
 * A pure function of the theme, so a test can read the numbers without
 * rendering the screen — and the defect it guards against was a pure style
 * defect: the notice stretched to 1,734px and pushed the composer off the
 * device. Nothing about that needed a render to see, and nothing about it was
 * visible in a text dump either, which is how it shipped.
 */
export function makeStyles(colors: ThemeColors) {
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
      /*
       * NEVER GROWS. This notice is one or two lines of text and nothing else.
       *
       * Without this it took the whole screen: `keyWaitText` carries `flex: 1`
       * so its label fills the WaitingStatus row, that row has no height of its
       * own, and the notice — a plain View in a column that had spare space —
       * stretched to fill it. Measured on the device at 1,734px tall with the
       * dots at the top and the hint pinned to the bottom of the screen, the
       * message list squeezed to nothing and the composer pushed off entirely.
       * The room looked broken and unusable, and the only thing actually wrong
       * was a missing `flexGrow`.
       */
      flexGrow: 0,
      flexShrink: 0,
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
    keyAskButton: {
      marginTop: 10,
      alignSelf: 'flex-start',
      minHeight: TOUCH_TARGET_MIN,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    keyAskButtonText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    keyAskState: {
      marginTop: 8,
      fontSize: TYPE_SCALE.caption,
      lineHeight: 18,
      color: colors.text.secondary,
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
      /*
       * Never squeezed out of the row.
       *
       * These controls sit to the LEFT of a bubble that may claim 75% of the
       * width, in a row aligned to the right — so when the bubble ran wide
       * (a pasted link is one long unbreakable word) the overflow went off the
       * left edge of the screen and Retry became unreachable. The bubble gives
       * way instead; it has text that wraps, and these do not.
       */
      flexShrink: 0,
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
      // Give way to the failed-send controls rather than pushing them off the
      // screen — see `sendFailed`.
      flexShrink: 1,
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
  const queryClient = useQueryClient();
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
  const failedRowStoreKey = `openstoa.failedSend.${topicId}`;
  const readFailedRows = useCallback(async (): Promise<PersistedFailedRow[]> => {
    try {
      const raw = await host.localStore?.getItem(failedRowStoreKey);
      return parseFailedRows(raw ?? null, Date.now());
    } catch {
      return [];
    }
  }, [host, failedRowStoreKey]);
  const writeFailedRows = useCallback(
    async (list: readonly PersistedFailedRow[]) => {
      try {
        await host.localStore?.setItem(failedRowStoreKey, serializeFailedRows(list));
      } catch {
        /* storage refused — the row still shows for this session */
      }
    },
    [host, failedRowStoreKey],
  );
  const forgetFailedRow = useCallback(
    async (rowId: string) => writeFailedRows(removeFailedRow(await readFailedRows(), rowId)),
    [readFailedRows, writeFailedRows],
  );

  /* Put back what the last run could not send. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await readFailedRows();
      if (cancelled || rows.length === 0) return;
      const now = Date.now();
      setSentMessages((curr) => {
        const known = new Set(curr.map((m) => m.id));
        const restored = rows
          .filter((r) => !known.has(r.rowId))
          .map((r) => {
            const base = {
              id: r.rowId,
              // A failed row is this client's by construction, so ownership
              // does not wait on the session lookup.
              userId: '',
              nickname: '',
              createdAt: new Date(r.createdAt).toISOString(),
              type: 'message',
              failed: true,
            };
            /*
             * A restored TEXT row is the words themselves, and Retry re-seals
             * from `message` — the same field a live failed row uses — so the
             * two are indistinguishable from here on. No expiry: unlike an
             * attachment, nothing it refers to can have been collected.
             */
            if (r.kind === 'text') return { ...base, message: r.text } as LocalMessage;
            return {
              ...base,
              message: r.body,
              mediaKey: r.key,
              // Only a HINT here — retry probes the object for real.
              mediaExpired: isFailedMediaExpired(r, now),
            } as LocalMessage;
          });
        return restored.length === 0 ? curr : [...curr, ...restored];
      });
      // Persist what the parse kept, so pruned rows are not re-read forever.
      await writeFailedRows(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [readFailedRows, writeFailedRows]);
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
  /** True in the caller's own space — the topic the account is created with. */
  const [isPersonal, setIsPersonal] = useState(false);
  /**
   * Members in this room, including this account; `null` until the lookup lands.
   *
   * The ask control needs to know whether anyone could answer, and the flag
   * above only knows that about ONE room per account. See `nobodyToAsk`.
   */
  const [memberCount, setMemberCount] = useState<number | null>(null);
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
    queryKey: topicKeys.chat(topicId),
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

  /*
   * WHEN THIS DEVICE'S CHAT KEYS CHANGE, ASK FOR THE HISTORY AGAIN.
   *
   * A room left open through a recovery stayed locked — see the counter's own
   * comment in `mobileTransport`. Invalidating from the recovery screen does
   * not work: the refetch lands while this screen still holds the MLS session
   * from before the recovery, the rows come back locked, and the entry is no
   * longer stale so returning refetches nothing.
   *
   * Subscribing here fixes the ORDER. A bump re-renders this screen first, so
   * `mls` above is already the rebuilt session by the time the effect below
   * asks for the history — the two steps cannot get out of sequence because
   * they are both inside one component.
   */
  const cryptoGeneration = useSyncExternalStore(subscribeCryptoGeneration, getCryptoGeneration);
  const firstGeneration = useRef(cryptoGeneration);
  useEffect(() => {
    // Not on mount: the query has just fetched with the session it has.
    if (cryptoGeneration === firstGeneration.current) return;
    void queryClient.invalidateQueries({ queryKey: topicKeys.chat(topicId) });
  }, [cryptoGeneration, queryClient, topicId]);

  /*
   * WHAT AN EMPTY LIST MEANS, decided once and outside the render tree.
   *
   * `아직 메시지가 없어요` used to render under every empty list, including
   * the one that is empty because the fetch failed. See `chatEmptyReason`.
   */
  const emptyLabelKey = chatEmptyLabelKey(
    chatEmptyReason({ historyStatus, streamStatus: status }),
  );

  /*
   * The room as this device last rendered it, read from disk before the network
   * answers anything.
   *
   * `useInfiniteQuery` is forced to `staleTime: 0, refetchOnMount: 'always'`
   * just above — for a good reason, a just-sent message lives only in
   * `liveMessages` and a served-stale page would lose it — but the cost is that
   * a restarted app has NOTHING to draw until `/chat` comes back. The archive
   * cache that covers it has existed since P3-17 and `backfill` reads and writes
   * it on every entry; nothing ever painted from it, because a cached row held
   * no author and the renderer needs one to name a bubble and place it.
   *
   * Merged LAST in `allMessages`, so the first-wins de-dupe below prefers every
   * live source and these rows only fill what has not arrived yet. Nothing here
   * can fail the room: a miss, an unreadable store and a first visit are the
   * same answer, and that answer is what shipped.
   */
  const [cachedMessages, setCachedMessages] = useState<LocalMessage[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cached = await tak.readHistoryCache?.(topicId);
        if (cancelled || !cached?.messages.length) return;
        setCachedMessages(
          cached.messages
            // No author means no bubble: skipped rather than rendered anonymous.
            .filter((m) => m.userId && m.nickname)
            .map((m) => ({
              id: m.id,
              topicId,
              userId: m.userId!,
              nickname: m.nickname!,
              profileImage: m.profileImage,
              message: m.plaintext,
              type: (m.type as ChatMessage['type']) ?? 'message',
              isAI: m.isAI,
              createdAt: m.createdAt,
            })) as LocalMessage[],
        );
      } catch {
        // A cache that cannot be read is a room that fetches.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topicId, tak]);

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
    for (const m of [...sentMessages, ...historyMsgs, ...catchupMessages, ...liveMessages, ...cachedMessages]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        // Fill pre-join rows MLS couldn't decrypt with TAK-recovered history.
        merged.push(
          m.message === UNREADABLE_BODY && recovered[m.id] ? { ...m, message: recovered[m.id] } : m,
        );
      }
    }
    // Sort chronologically (oldest → newest); the FlatList renders top-down.
    merged.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return merged;
  }, [data, sentMessages, catchupMessages, liveMessages, cachedMessages, recovered]);

  /*
   * Remember the room as rendered, so the next launch can paint before it asks.
   *
   * The counterpart of the cache read above. `backfill` already writes rows it
   * OPENED, but those carry no author — it works from `ArchiveEntry`, which is
   * ciphertext and a timestamp — so a room restored from them could show bodies
   * with nobody attached. These rows have been through the renderer, so they
   * have everything a bubble needs.
   *
   * Write-behind and unawaited: this is a copy of what is already on screen, and
   * `writeHistoryCache` merges and bounds it. Optional-call because several
   * suites swap the store for a partial stand-in.
   */
  useEffect(() => {
    if (!allMessages.length) return;
    const rows = allMessages
      /*
       * In flight, failed, locked, or bodiless: re-derived rather than stored.
       *
       * `message` is nullable here in a way it is not on the web — a join or
       * leave notice carries no body — and storing one would restore a bubble
       * with nothing in it. The type checker caught this; the filter is what
       * keeps it caught.
       */
      .filter(
        (m) =>
          !m.pending &&
          !m.failed &&
          typeof m.message === 'string' &&
          m.message !== UNREADABLE_BODY,
      )
      .map((m) => ({
        id: m.id,
        createdAt: m.createdAt,
        plaintext: m.message as string,
        userId: m.userId,
        nickname: m.nickname,
        // Normalised, not widened: this record is JSON, where `undefined`
        // drops the key and `null` costs bytes to store the absence of a value.
        profileImage: m.profileImage ?? undefined,
        type: m.type,
        isAI: m.isAI,
      }));
    if (rows.length) void tak.writeHistoryCache?.(topicId, rows)?.catch(() => {});
  }, [allMessages, topicId, tak]);

  /** Rows on screen this device cannot open. */
  const lockedCount = useMemo(
    () => allMessages.reduce((n, m) => (m.message === UNREADABLE_BODY ? n + 1 : n), 0),
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
   * ASKING A MEMBER TO UNLOCK THE STRETCH THIS DEVICE CANNOT READ.
   *
   * A recovered phone opens `private`, `secret` and `dm` rooms only as far as
   * the OLD phone's last backup — epochs that advanced while it was off never
   * reached that device's keychain, so they were never in the blob. The keys
   * still exist, on the devices of members who were online, so the missing step
   * is an ASK rather than any cryptography.
   *
   * `public` is excluded: the server holds the archive root there, so a locked
   * row means something else, and this button would send the person down the
   * wrong path. See `tierCanAsk`.
   */
  const [keyAskSending, setKeyAskSending] = useState(false);
  const [keyAskMine, setKeyAskMine] = useState<{ granted: boolean } | null>(null);
  const keyAsk = askStatus({
    lockedCount,
    tier,
    mine: keyAskMine,
    sending: keyAskSending,
    personal: isPersonal,
    memberCount,
  });

  useEffect(() => {
    // Only look when there is something to look for — a room that opens fine
    // has no reason to ask the server about requests.
    if (!awaitingRoomKey || !tierCanAsk(tier)) return;
    let cancelled = false;
    void (async () => {
      try {
        const dev = await tak.myDeviceId(topicId);
        const res = await client.get<{ mine: { granted: boolean } | null }>(
          `/api/topics/${topicId}/keys/request?deviceId=${encodeURIComponent(dev)}`,
        );
        if (!cancelled) setKeyAskMine(res.mine);
      } catch {
        // A room that cannot reach the server still shows its messages; the
        // button simply stays in its "offer" state and the tap will report.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [awaitingRoomKey, tier, topicId, tak, client]);

  /*
   * THE OTHER HALF: who is waiting for keys THIS device might hold.
   *
   * Without it the ask is a doorbell nobody can hear — a row lands in the
   * database, no screen shows it, and the person waits for something that was
   * never going to happen.
   *
   * Polled on the same terms as the room itself rather than on a timer: a
   * member opening a room is exactly when they can help, and a background poll
   * would be work done for a screen nobody is looking at.
   */
  const [pendingKeyRequests, setPendingKeyRequests] = useState<PendingKeyRequest[]>([]);

  const refreshKeyRequests = useCallback(() => {
    /*
     * `public` rooms get the archive root from the server, so there is nobody
     * to ask. Not logged: this is the common case, and a line that narrates
     * normal behaviour on every render is the noise a real warning hides in.
     * The FAILURE path below does log, which is what found the defect this
     * feature shipped with.
     */
    if (!tierCanAsk(tier)) return;
    void (async () => {
      try {
        const res = await client.get<{ requests: PendingKeyRequest[] }>(
          `/api/topics/${topicId}/keys/request`,
        );
        // Never offer to answer your own ask.
        const mineDev = await tak.myDeviceId(topicId);
        setPendingKeyRequests(
          (res.requests ?? []).filter((r) => r.requesterDeviceId !== mineDev),
        );
      } catch (e) {
        /*
         * SAY WHY. A silent catch here cost an hour of device debugging: the
         * list simply did not appear, and nothing distinguished "no requests"
         * from "the fetch failed". The room still works without it, so this
         * stays non-fatal — but it stops being invisible.
         */
        console.warn('[chat] key-request list failed', String(e));
        setPendingKeyRequests([]);
      }
    })();
  }, [client, tak, tier, topicId]);

  useEffect(() => {
    refreshKeyRequests();
  }, [refreshKeyRequests]);

  /**
   * Seal the missing epochs to the asker, THEN mark the request answered.
   *
   * The order is the whole point. Marking first would let the asker stop
   * waiting and drop the row from every member's list while nothing had left
   * this device. A grant that reached zero leaves is therefore not marked: this
   * device does not hold that stretch either, and somebody else has to answer.
   */
  const grantKeys = useCallback(
    async (req: PendingKeyRequest): Promise<number> => {
      const leaves = await tak.grantMissingTo(topicId, req.requesterUserId, req.haveFromEpoch);
      if (leaves > 0) {
        await client.post(`/api/topics/${topicId}/keys/grant`, { requestId: req.id });
      }
      return leaves;
    },
    [client, tak, topicId],
  );

  const askForKeys = useCallback(() => {
    void (async () => {
      setKeyAskSending(true);
      try {
        const dev = await tak.myDeviceId(topicId);
        /*
         * SAY WHAT WE ALREADY HAVE.
         *
         * Without it every ask means "send me everything", so a member re-seals
         * the whole history each time — including the stretch this device can
         * already read. `oldestReadableEpoch` returns null when nothing is
         * readable, which the server reads as exactly that, and keeps 0 as the
         * real answer it is rather than collapsing it to null.
         */
        const held = await tak.heldEpochs(topicId).catch(() => [] as number[]);
        await client.post(`/api/topics/${topicId}/keys/request`, {
          deviceId: dev,
          haveFromEpoch: oldestReadableEpoch(held),
        });
        setKeyAskMine({ granted: false });
      } catch {
        setKeyAskMine(null);
      } finally {
        setKeyAskSending(false);
      }
    })();
  }, [client, tak, topicId]);
  /*
   * While the spinner is up, an unreadable row shows NOTHING rather than a
   * placeholder. One spinner for the room, not a column of identical dots.
   */
  const visibleMessages = useMemo(
    () => (syncing ? allMessages.filter((m) => m.message !== UNREADABLE_BODY) : allMessages),
    [allMessages, syncing],
  );
  /**
   * The same conversation, NEWEST FIRST, for an inverted list.
   *
   * WHY THE LIST IS INVERTED, which is the whole answer to "the room jumps".
   *
   * A normal list puts the newest message at the far end of the content, so
   * "show me the newest" means "scroll to the bottom" — and the bottom is a
   * moving target. Every picture that decrypts, every sealed row that opens,
   * every prepended page of history changes where the bottom IS, so the view
   * has to chase it. Three separate mechanisms were doing that chasing here
   * (`maintainVisibleContentPosition`, an `onContentSizeChange` scroll, an
   * `onLayout` scroll) and they contradicted each other by construction: the
   * anchor's job is to HOLD a row still, the other two force the view to the
   * end. With several pictures resolving a few frames apart, that argument
   * runs once per picture, which is the "올라갔다 내려갔다" the owner filmed.
   *
   * Inverted, the newest message sits at offset 0. Opening a room is not a
   * scroll at all — the view is already there — and content that grows grows
   * AWAY from the reader instead of underneath them. There is nothing to
   * chase, so nothing can fight over it.
   *
   * This is what the clients the owner compared us against do. Signal Android
   * sets `setReverseLayout(true)` on the conversation's LinearLayoutManager;
   * Telegram for Android builds its ChatListView with a reversed layout the
   * same way. Neither has a scroll-to-bottom-on-growth path, because neither
   * needs one.
   *
   * The row renderer still reads `prevItem` as "the message BEFORE this one in
   * time", so the neighbour it is handed is the NEXT index here — see the
   * renderer. Getting that backwards silently regroups every avatar and
   * timestamp, so it is stated rather than inferred.
   */
  const invertedMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
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
        /*
         * Through the query cache, on the key the topic screens already use.
         *
         * A raw `client.get` here meant opening a room always paid for the
         * topic again — even when the topic screen one tab away had just
         * fetched it — and nothing else could reuse what this fetched either.
         * `ensureQueryData`, not `fetchQuery`: the latter honours staleness and
         * refetches an entry the moment it is stale, which with the app's
         * `staleTime: 0` is immediately — so it would have shared nothing. What
         * this needs is "use what we have, fetch only if we have none", and a
         * topic's visibility changes rarely and invalidates this exact key when
         * it does (`TopicDetailScreen` on save).
         */
        const tj = await queryClient.ensureQueryData<{
          topic?: { visibility?: string; personal?: boolean; memberCount?: number };
          visibility?: string;
          personal?: boolean;
          memberCount?: number;
          currentUserRole?: string | null;
        }>({
          queryKey: topicKeys.detail(topicId),
          queryFn: () => client.get(`/api/topics/${topicId}`),
        });
        const v = (tj?.topic?.visibility ?? tj?.visibility) as Visibility | undefined;
        if (v === 'public' || v === 'private' || v === 'secret') {
          visibilityRef.current = v;
          setVisibility(v);
        }
        tierRef.current = chatTierOf(visibilityRef.current, kind === 'dm');
        // A room of one: the ask control has nobody to ask. See `askStatus`.
        setIsPersonal(Boolean(tj?.topic?.personal ?? tj?.personal));
        // The same question asked of the membership rather than of a flag, so
        // an ordinary room everyone else left answers it too. Left at `null`
        // when the field is missing — unknown must not read as alone.
        const mc = tj?.topic?.memberCount ?? tj?.memberCount;
        setMemberCount(typeof mc === 'number' && Number.isFinite(mc) ? mc : null);
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
                m.message !== UNREADABLE_BODY &&
                !isProvisionalId(m.id),
            )
            .map((m) => ({ messageId: m.id, plaintext: m.message as string, createdAt: m.createdAt })),
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
            (n, m) => (m.message === UNREADABLE_BODY ? n + 1 : n),
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
  /*
   * No `readerDrivenScrollRef` any more.
   *
   * It existed because a list that grew emitted scroll events that looked like
   * the reader leaving the bottom, and honouring them switched the re-pin off.
   * Inverted, growth does not move the reader's offset at all, so a scroll
   * event means what it says and needs no provenance test.
   */

  /**
   * Bring the reader back to the newest message.
   *
   * Inverted, that is offset 0 — a fixed point, not a moving floor. The old
   * version of this scheduled TWO scrolls (one on the next frame, one 300ms
   * later) to catch pictures that resolved late; the second one was itself a
   * visible jump, and neither is needed once growth happens away from the
   * reader instead of underneath them.
   *
   * Only called when the reader is ALREADY at the newest and a new message
   * arrives. Someone reading history is left where they are.
   */
  const scrollToNewest = useCallback((animated: boolean) => {
    listRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);

  useEffect(() => {
    if (allMessages.length === 0) return;
    const newLastId = allMessages[allMessages.length - 1]?.id ?? null;
    if (!newLastId || newLastId === lastBottomIdRef.current) return;
    const wasFirstLoad = lastBottomIdRef.current === null;
    lastBottomIdRef.current = newLastId;
    /*
     * The first load needs no scroll at all — an inverted list opens at offset
     * 0, which is the newest message. Scrolling there would be a no-op that
     * can still flash on a list still measuring its rows.
     */
    if (wasFirstLoad) {
      userNearBottomRef.current = true;
      return;
    }
    // A message arrived while the reader was reading older ones: leave them be.
    if (!userNearBottomRef.current) return;
    scrollToNewest(true);
  }, [allMessages, scrollToNewest]);

  // ── Presence header decoration ─────────────────────────────────────────────
  // Member list, reachable from inside the room (not just from the topic's
  // own detail screen) — reuses TopicMembersScreen wholesale rather than a
  // second member-list surface. DM rooms skip this: the "members" are
  // already the two people named in the header (see `kind` above).
  const openMembers = useCallback(() => {
    /*
     * Pushed on THIS stack, not jumped to under Topics.
     *
     * Jumping tabs put the member list on a stack it does not belong to, as
     * the only route there — so it drew no back arrow and the only way out was
     * the tab bar, which cannot return you to the conversation you were
     * reading. Found on the device: the screen opened and there was no way
     * back to the room.
     */
    (navigation as unknown as { navigate: (name: string, params: unknown) => void }).navigate(
      'TopicMembers',
      { topicId },
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
      /*
       * Inverted, offset 0 IS the newest message, so "near the newest" is a
       * distance from zero rather than a distance from a content height that
       * changes every time a picture decrypts. That dependence on a moving
       * number is what used to switch the re-pin off at the exact moment it
       * was needed; there is no moving number left to depend on.
       *
       * Pagination is not here any more either — the list asks for older pages
       * through `onEndReached`, which says what it means.
       */
      userNearBottomRef.current = nativeEvent.contentOffset.y < 120;
    },
    [],
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
        const res = await client.post<{ message: ChatMessage }>(
          `/api/topics/${topicId}/chat`,
          {
            ciphertext: sealed.ciphertext,
            epoch: sealed.epoch,
            ...(pushArchive ? { pushArchive } : {}),
          },
        );
        if (!res?.message?.id) throw new Error('no message id');
        // Swap the provisional row for the stored one IN PLACE, so the bubble
        // does not jump: same position, real id, no longer pending.
        setSentMessages((curr) =>
          curr.map((m) => (m.id === pendingId ? { ...res.message, message: text } : m)),
        );
        // The message is out, so the failed row it may have come from is done.
        void forgetFailedRow(pendingId);
        // Cache own plaintext so it survives a restart (sender can't self-decrypt).
        void mls.cachePlaintext(topicId, res.message.id, text);
        // Re-encrypt for the archive so later members can read it (Phase 3).
        void tak.archiveOnSend(topicId, res.message.id, text, tierRef.current).catch(() => {});
        // Only NOW is the object referenced by a real message, so only now may
        // the unclaimed collector leave it alone.
        if (media) void client.claimChatMedia(topicId, media.key).catch(() => {});
      } catch (err) {
        /*
         * Say WHY, somewhere a later session can read.
         *
         * This catch threw the reason away for as long as it has existed, and
         * that cost a whole afternoon: a send was dying inside `mls.seal`, the
         * screen showed the same Resend row it shows for a dropped connection,
         * and the only way to tell the two apart was to reason backwards from
         * the edge's access log. One line here would have named it outright.
         * `report` narrates to the server sink because a release build runs
         * Hermes, whose console output never reaches the device log.
         */
        report('chat.send.failed', {
          topicId,
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          isAttachment: !!parseChatMediaBody(text),
        });
        /*
         * Keep the words where the OS cannot take them.
         *
         * The bubble alone was not enough. It lived in component state, so a
         * backgrounded app reclaimed by Android took the sentence with it — the
         * user did nothing, came back, and the message was simply gone. The
         * same defect was fixed for attachments and words were left behind,
         * which is how a photo nobody watched fail outlived a sentence someone
         * did.
         *
         * Written BEFORE the row is redrawn, because the process can die
         * between the two, and losing it there is precisely what this fixes.
         * Attachments are skipped: their failure path stores the envelope, and
         * writing the same row again as text would restore a bubble of JSON.
         */
        if (!parseChatMediaBody(text)) {
          await writeFailedRows(
            addFailedRow(await readFailedRows(), {
              kind: 'text',
              rowId: pendingId,
              text,
              createdAt: Date.now(),
            }),
          ).catch(() => {
            // Storage refused. The row still shows for this session, which is
            // the behaviour that shipped before any of this existed.
          });
        }
        // The text stays in the bubble, never back in the composer — the reader
        // decides whether to resend or drop it.
        setSentMessages((curr) =>
          curr.map((m) =>
            m.id === pendingId ? { ...m, pending: false, retrying: false, failed: true } : m,
          ),
        );
      }
    },
    [mls, tak, client, topicId, buildPushArchive, forgetFailedRow, readFailedRows, writeFailedRows],
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
        curr.map((m) => (m.id === msg.id ? { ...m, retrying: true } : m)),
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
              m.id === msg.id
                ? { ...m, pending: false, retrying: false, failed: true, mediaExpired: true }
                : m,
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
      void forgetFailedRow(msg.id);
    },
    [client, topicId, forgetFailedRow],
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
          seal: async (mediaId, plain) => {
            const sealed = await tak.sealMedia(topicId, mediaId, plain, tierRef.current);
            /*
             * Remember what THIS app just encrypted, so the sender's own bubble
             * does not download and decrypt a picture it chose from this phone
             * moments ago. Measured on the web, that redundant round trip was
             * 2441ms of 8661ms for a 7.7MB image; a phone on mobile data pays
             * more, not less.
             *
             * After the seal, so a failed seal caches nothing. `plain` is the
             * exact buffer handed over — post-EXIF-strip, post-HEIC-convert —
             * so the bubble cannot differ from the same bubble after a restart.
             */
            if (sealed) rememberSentChatMedia(mediaId, plain, mime);
            return sealed;
          },
          upload: (ciphertext, mediaId) => client.uploadChatMedia(topicId, mediaId, ciphertext),
          send: async (body) => {
            const sealed = await mls.seal(topicId, body);
            /*
             * No push preview for an attachment: the preview is a copy of the
             * BODY, and this body is an envelope, so the recipient's
             * notification would read as a line of JSON.
             */
            const res = await client.post<{ message: ChatMessage }>(
              `/api/topics/${topicId}/chat`,
              { ciphertext: sealed.ciphertext, epoch: sealed.epoch },
                );
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
       * The row about to be drawn says "this did not send" and offers Retry.
       * It does NOT say why, and it cannot — the reason is a sentence for a
       * developer, not for the sender. Written here in full (CLAUDE.md: never
       * truncate a server-side log) because the alternative is what happened
       * on 2026-08-25: an attachment failing with the cause sitting in
       * `err.message`, discarded one line later, and a night spent guessing.
       */
      console.error('[chat/media] attachment send failed', err);
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
          await writeFailedRows(
            addFailedRow(await readFailedRows(), {
              kind: 'media',
              rowId,
              body,
              key: stored.key,
              createdAt: Date.now(),
            }),
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
      Alert.alert(t('openstoa.attach.pickerUnavailableTitle'), t('openstoa.attach.pickerUnavailableBody'));
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
      Alert.alert(t('openstoa.attach.clipboardUnavailableTitle'), t('openstoa.attach.clipboardUnavailableBody'));
      return;
    }
    const hasImage = await Clipboard.hasImage();
    if (!hasImage) {
      Alert.alert(t('openstoa.attach.noImageInClipboard'));
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
          options: [
            t('openstoa.common.cancel'),
            t('openstoa.attach.photoLibrary'),
            t('openstoa.attach.pasteFromClipboard'),
          ],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) pickFromLibrary();
          else if (buttonIndex === 2) pasteFromClipboard();
        },
      );
    } else {
      Alert.alert(t('openstoa.attach.title'), undefined, [
        { text: t('openstoa.attach.photoLibrary'), onPress: pickFromLibrary },
        { text: t('openstoa.attach.pasteFromClipboard'), onPress: pasteFromClipboard },
        { text: t('openstoa.common.cancel'), style: 'cancel' },
      ]);
    }
  }, [pickFromLibrary, pasteFromClipboard, t]);

  // ── Render ────────────────────────────────────────────────────────────────
  /*
   * A spinner only when there is genuinely NOTHING to show.
   *
   * `historyStatus === 'pending'` is true until `/chat` answers, so this used to
   * hold the list back even when the device already had the room on disk — the
   * cache was read, the rows were in state, and the screen drew a spinner over
   * them. Rows restored from the cache are rows this device rendered before;
   * showing them while the fetch is in flight is the behaviour the cache exists
   * to buy, and the fetch still reconciles them the moment it lands.
   */
  const isFirstLoad = historyStatus === 'pending' && allMessages.length === 0;

  return (
    <>
    <KeyboardAvoidingView
      style={styles.flex}
      behavior="padding"
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
       * BOTH PLATFORMS. Android used to be left out — `behavior` was undefined
       * there — on the grounds that the activity is `adjustResize` and the
       * window therefore already moves. That was true when it was written and
       * is not true now: the app targets SDK 36, and from SDK 35 an app is
       * edge-to-edge by default unless it opts out, which this one does not.
       * Under edge-to-edge the platform stops resizing the window for the IME,
       * so `adjustResize` in the manifest does nothing and the composer sits
       * behind the keyboard.
       *
       * The premise died at a distance: a correct targetSdk bump somewhere else
       * killed it, and nothing here could report that, because from this file's
       * point of view nothing had changed.
       *
       * The two screens this comment used to cite as working — PostDetailScreen
       * and PostCreateScreen — dock their composers with `KeyboardStickyView`,
       * which takes no `behavior` at all. They were never evidence that Android
       * needs none here; they were evidence that a different component does not.
       *
       * `translate-with-padding`, not plain `padding`. Plain padding left a
       * 23dp band of dead screen between the composer and the keyboard —
       * measured off the device, not estimated: the composer bar ended at
       * y=1335 and the keyboard toolbar began at y=1400 on a 450dpi panel.
       * Padding alone double-counts, because Android moves part of the way on
       * its own; translating the view and padding only the remainder is the
       * variant that does not need a constant to correct it, and a constant is
       * exactly what this comment already records nobody being able to derive
       * twice running.
       */
      /*
       * `automaticOffset` ON IOS ONLY — measured, not reasoned.
       *
       * It asks the native side for the view's true position in the window so
       * the padding is the ACTUAL overlap, which is what iOS needs and why it
       * replaced the hand-tuned constant. On Android it DOUBLE-COUNTS: the
       * platform has already moved part of the way, so adding the full overlap
       * on top left a band of dead screen between the composer and the keys.
       *
       * Three builds on the device, each scanned pixel-row by pixel-row:
       *   behavior undefined              composer behind the keyboard
       *   padding + automaticOffset       composer 65px (23dp) too high
       *   translate-with-padding          composer pushed off screen entirely
       *   padding, no automaticOffset     composer bottom 1399, keys 1400 — flush
       *
       * The split is by evidence from both platforms, not by a constant nobody
       * could derive twice.
       */
      automaticOffset={Platform.OS === 'ios'}
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
          {/* One tap, and only where a member can actually answer it. */}
          {keyAsk !== 'hidden' ? (
            askIsPressable(keyAsk) ? (
              <TouchableOpacity
                onPress={askForKeys}
                accessibilityRole="button"
                testID="chat-key-ask"
                style={styles.keyAskButton}
              >
                <Text style={styles.keyAskButtonText}>{t(askLabelKey(keyAsk, tier)!)}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.keyAskState} testID="chat-key-ask-state">
                {t(askLabelKey(keyAsk, tier)!)}
              </Text>
            )
          ) : null}
        </View>
      ) : null}

      {pendingKeyRequests.length > 0 ? (
        <View style={styles.keyWaitNotice} testID="chat-key-requests">
          {/* Shown to members who CAN read the room — they are the ones able to
              help, and they are not in the `awaitingRoomKey` state at all. */}
          <KeyRequestList
            requests={pendingKeyRequests}
            onGrant={grantKeys}
            onRefresh={refreshKeyRequests}
          />
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
          /*
           * INVERTED. The newest message is at offset 0, so "open at the
           * newest" is not a scroll — it is where the list already starts.
           * See `invertedMessages` for why this replaced three fighting
           * scroll-to-bottom mechanisms rather than joining them.
           */
          inverted
          data={invertedMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <ChatMessageRow
              item={item}
              onRetry={retryFailed}
              onDiscard={discardFailed}
              syncing={syncing}
              awaitingKey={awaitingRoomKey}
              /*
               * The row before this one IN TIME. The array runs newest-first,
               * so that neighbour is the NEXT index, not the previous one —
               * the row uses it to decide whether to repeat an avatar and a
               * timestamp, and reading it backwards regroups the whole
               * conversation without erroring.
               */
              prevItem={
                index + 1 < invertedMessages.length ? invertedMessages[index + 1] : undefined
              }
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
          /*
           * Older history loads at the list's END, which inverted means the
           * TOP of the screen — the direction the reader scrolls to go back.
           * This replaces the old `onScroll` offset test: an offset threshold
           * had to be re-derived every time the content grew, and `onEndReached`
           * states the intent directly.
           */
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          /*
           * Read-position tracking only. Nothing here moves the view: with the
           * newest message at offset 0, "am I at the newest" is simply "is the
           * offset near zero", and no mechanism has to chase a moving floor.
           */
          onScroll={onScrollTop}
          scrollEventThrottle={64}
          /*
           * Inverted, the list header renders at the far end — visually the
           * TOP — which is where a page of older history arrives.
           */
          ListHeaderComponent={null}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View style={styles.loadingMore}>
                <ActivityIndicator size="small" color={colors.brand.primary} />
              </View>
            ) : null
          }
          /*
           * An empty list is not the same as an empty room. While a fetch is
           * still in flight there is no sentence at all, so nothing flickers
           * into view and straight back out.
           */
          ListEmptyComponent={
            emptyLabelKey ? (
              <View style={styles.center}>
                <Text style={styles.emptyText}>{t(emptyLabelKey)}</Text>
              </View>
            ) : null
          }
        />
      )}

      <OfflineNotice
        offline={status !== 'open' && status !== 'rejected'}
        signedOut={status === 'rejected'}
        styles={styles}
      />

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
      saveLabel={t('openstoa.chat.media.share')}
      closeLabel={t('openstoa.chat.media.close')}
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
  const { t } = useTranslation();

  // System messages (join / leave only — every other type renders as a
  // regular message bubble below). The previous code did `type !==
  // 'message' ? 'joined' : 'left'` which incorrectly rendered every
  // non-'message' / non-'join' row (including 'ai') as "left the room"
  // and dropped the body entirely.
  if (item.type === 'join' || item.type === 'leave') {
    /*
     * Built by the translator, not glued together here. The old shape was
     * `{item.nickname} {verb} the room`, which is English on a Korean screen —
     * and invisible to the leftover-English sweep, because the sweep read the
     * text BETWEEN the tags and this had expressions in the middle of it.
     */
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemMsg}>
          {t(
            item.type === 'join'
              ? 'openstoa.chat.joinedRoom'
              : 'openstoa.chat.leftRoom',
            { nickname: item.nickname },
          )}
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
  // The decision lives in `lib/messageSide` so it can be guarded; the screen
  // cannot be rendered with an ordinary message in a unit test. See that file.
  const isOwn = isOwnMessage(item, sessionUserId);
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

function OfflineNotice({
  offline,
  signedOut,
  styles,
}: {
  offline: boolean;
  /*
   * The server REFUSED the credential — twice, each time with a freshly read
   * token. Not the same thing as a connection that dropped, and it must not say
   * "reconnecting": there is nothing to reconnect to until the person signs in
   * again, and a message that keeps promising a recovery that cannot happen is
   * the reason somebody sits waiting instead of acting.
   *
   * Shown at once rather than after the ten-second delay. The delay exists so a
   * momentary blip does not blink a banner; a refusal is not momentary.
   */
  signedOut: boolean;
  styles: Styles;
}) {
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

  if (!show && !signedOut) return null;
  return (
    <View style={styles.offlineBar} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Text style={styles.offlineBarText} numberOfLines={2}>
        {t(signedOut ? 'openstoa.signInPrompt.expiredTitle' : 'openstoa.chat.offline.body')}
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
      /*
       * ALREADY DECRYPTED, ON THIS DEVICE. Checked before anything else.
       *
       * A picture is decrypted ONCE. The display file is named from the media
       * id, so the second view of a photo finds the first view's plaintext and
       * skips both the download and the AES — 179ms + 3,086ms on a 6MB
       * attachment, per picture, per entry into the room. This is the whole
       * reason re-entering a room with ten photos was as slow as the first time.
       *
       * `<Image>` reads the file, so the bytes are NOT loaded into JS here.
       * `state` therefore records the hit without them; the share sheet reads
       * them back from the file when it actually needs them (see below).
       */
      const cached = existingDecrypted({ fs: hostAttachmentFs(), mime, mediaId });
      if (cached) {
        if (cancelled) return;
        fileRef.current = cached;
        setFileUri(cached.uri);
        setState({ status: 'ok', bytes: null, mime });
        return;
      }

      /*
       * THE SENDER'S OWN BUBBLE. A hit skips the download and the decrypt
       * entirely; a miss falls through to the reader path below, which is what
       * a restart, the recipient and the sender's other device all take.
       *
       * Matched on the ENVELOPE's size and mime, not just the id, so a cached
       * entry that disagrees with what this row describes is treated as a miss.
       */
      const own = readSentChatMedia(mediaId, size, mime);
      if (own) {
        const file = writeDecrypted({ fs: hostAttachmentFs(), bytes: own.bytes, mime: own.mime, mediaId });
        if (cancelled) return;
        fileRef.current = file;
        setFileUri(file?.uri ?? null);
        setState({ status: 'ok', bytes: own.bytes, mime: own.mime });
        return;
      }

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
      // `bytes` is only null on the cache-hit path above, which returned
      // already — a fresh decrypt always carries them. Narrowed rather than
      // asserted so a future path that forgets is a compile error.
      if (res.status === 'ok' && res.bytes) {
        const file = writeDecrypted({ fs: hostAttachmentFs(), bytes: res.bytes, mime: res.mime, mediaId });
        fileRef.current = file;
        setFileUri(file?.uri ?? null);
      }
      setState(res);
    })();
    return () => {
      cancelled = true;
      /*
       * THE PLAINTEXT STAYS. This is what makes "decrypt once" true.
       *
       * It used to be deleted here, on the argument that a decrypted picture
       * from an end-to-end encrypted conversation must not outlive the row. That
       * argument does not survive being written down: the file is in this app's
       * own sandboxed cache directory, and the key that opens the ciphertext is
       * on the same device in the keychain. Anyone who can read this directory
       * can read that key and decrypt the whole archive themselves, so deleting
       * the picture took no capability away from them — it only made the owner
       * of the phone pay AES again on every re-entry. End-to-end encryption
       * protects the picture in transit and at rest ON THE SERVER; a cache file
       * here changes neither.
       *
       * `fileRef` is still cleared so a re-run cannot hand a stale handle to
       * the share sheet.
       */
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

  /*
   * RESERVE THE ROW BEFORE THE PICTURE ARRIVES.
   *
   * Each state below used to be one line of text tall, so the row grew by
   * hundreds of pixels the moment the image decoded. A room opened pinned to
   * the newest message and, with four pictures on screen, ended up stranded in
   * the middle — caught on video entering from a push notification.
   *
   * `maintainVisibleContentPosition` cannot fix that. It holds a row still; it
   * does not stop a row from growing. And the auto-scroll that would re-pin is
   * gated on still being near the bottom, which the growth itself has already
   * made false. The only thing that works is not growing.
   *
   * The SAME box `ChatImage` will settle on, from the same shared rule — a
   * lookalike would just move the jump to the swap. Messages sent before the
   * sender measured the picture have no dimensions, and `chatMediaBox` gives
   * them its own default, so those rows behave exactly as they did before.
   */
  const box = chatMediaBox(envelope.w, envelope.h, CHAT_IMAGE_SLOT_WIDTH);
  const reserved = { width: box.width, height: box.height, justifyContent: 'center' as const, alignItems: 'center' as const };

  if (state === null) {
    return (
      <View style={[wrap, reserved]}>
        <Text style={styles.lockedBody}>{t('openstoa.chat.media.decrypting')}</Text>
      </View>
    );
  }
  if (state.status === 'locked') {
    return (
      <View style={[wrap, reserved]}>
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
          hintWidth={envelope.w}
          hintHeight={envelope.h}
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
    rawContent === UNREADABLE_BODY
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
      } catch (err) {
        /*
         * A refusal from OUR OWN edge is not an answer about the link.
         *
         * Everything below treats a failure as "this site has no preview" and
         * remembers it for an hour. When the edge was rate-limiting us, that
         * turned a moment's refusal into a permanent verdict: the card for a
         * perfectly good link never came back, not on scroll, not on reopening
         * the room. Seen on 2026-08-28 — a Claude link and a Naver place link
         * both lost their card that way, and the second one had already been
         * scraped successfully; only the picture was refused.
         *
         * Rethrow so the query records a failure instead of caching a null,
         * and let it retry once.
         */
        if (isEdgeRefusal(err)) throw err;
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
    /*
     * A link with no preview is the normal outcome for plenty of sites, not a
     * transient error — retrying just repeats a request already answered. The
     * one exception is our own edge refusing us, which says nothing about the
     * link; that one is worth asking again once the ban has had time to lift.
     */
    retry: (count, err) => isEdgeRefusal(err) && count < EDGE_REFUSAL_RETRIES,
    retryDelay: edgeRefusalRetryDelayMs,
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
  const locked = item.message === UNREADABLE_BODY;
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
        {/*
          * A NOTICE NAMES NOBODY. It is filed with the reader's own token — the
          * only token that can seal into their room — so `item.nickname` is the
          * READER'S, and heading the bubble with it says they wrote something
          * they did not. Moving it to the received side (`messageSide`) fixed
          * the SIDE and left the NAME: on a phone it read as a message from
          * yourself, addressed to yourself. The chat list had the same defect
          * and its own fix (`chatPreview`); this is the room's half.
          *
          * FOR THE NEXT EDIT: `{!isOwn && !sameAuthor ?` appears TWICE in this
          * file — here, and around the timestamp below. A first attempt at this
          * landed on the timestamp and changed nothing a person could see.
          */}
        {!isOwn && item.type !== 'notice' && !sameAuthor ? (
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
            retrying={item.retrying}
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

