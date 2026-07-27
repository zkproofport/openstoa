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
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
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
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@openstoa/api-types';
import { useChatSocket } from '../../api/chatSocket';
import { getMlsSessionStore, getTakSessionStore, toDisplayMessageMls } from '../../crypto/mobileTransport';
import type { Visibility } from '../../crypto/takSession';
import type { TakSessionStore } from '../../crypto/takSession';
import type { MlsSessionStore } from '../../crypto/mlsSession';
import {
  grantAiConsent,
  grantAiHistory,
  removeAiMember,
  type AiMemberDirectory,
  type AiGrantSpec,
} from '../../crypto/aiMember';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { formatRelativeTime } from '../../utils/relativeTime';
import { OGPreviewCard } from '../../components/OGPreviewCard';
import type { OGData } from '../../components/OGPreviewCard';
import ImageViewerModal from '../../components/ImageViewerModal';
import type { ChatStackParamList } from '../../navigation/stacks/ChatStack';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useAuthGuardedAction } from '../../auth';

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
// Last-seen timestamp cache (in-memory, per process)
// ---------------------------------------------------------------------------
// Used to drive `?since=<iso>` delta sync on chat re-entry within the same
// app session. Survives screen mount/unmount but resets when the app
// process is killed. Persisting across restarts (AsyncStorage / MMKV) is a
// later Phase 5 concern.
const lastSeenByTopic = new Map<string, string>();

function getLastSeen(topicId: string): string | undefined {
  return lastSeenByTopic.get(topicId);
}

function setLastSeen(topicId: string, iso: string): void {
  const prev = lastSeenByTopic.get(topicId);
  if (!prev || new Date(iso) > new Date(prev)) {
    lastSeenByTopic.set(topicId, iso);
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background.primary },

    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    emptyText: {
      fontSize: 14,
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
      fontSize: 11,
      color: colors.text.tertiary,
      backgroundColor: colors.background.secondary,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 10,
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
      fontSize: 12,
      fontWeight: '600',
      color: colors.brand.primary,
      marginRight: 6,
    },
    msgTime: {
      fontSize: 10,
      color: colors.text.tertiary,
    },
    body: {
      fontSize: 15,
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
      borderRadius: 4,
      backgroundColor: colors.status.success,
      marginRight: 4,
    },
    presenceCount: {
      fontSize: 13,
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
    statusText: { fontSize: 12, color: colors.text.secondary },
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
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    bubbleOwn: {
      backgroundColor: colors.brand.primary,
      borderBottomRightRadius: 4,
    },
    bubbleOther: {
      backgroundColor: colors.background.secondary,
      borderBottomLeftRadius: 4,
    },
    bubbleTextOwn: {
      fontSize: 15,
      lineHeight: 21,
      color: '#FFFFFF',
    },
    bubbleTextOther: {
      fontSize: 15,
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
      fontSize: 12,
      fontWeight: '600' as const,
      color: colors.brand.primary,
    },
    // AI-member badge (design §7 D9 — nickname + AI badge, is_ai=true).
    aiBadge: {
      fontSize: 9,
      fontWeight: '700' as const,
      color: colors.background.primary,
      backgroundColor: colors.brand.primary,
      overflow: 'hidden' as const,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
      marginLeft: 6,
    },
    // ── AI consent sheet ──────────────────────────────────────────────────
    headerBtn: { paddingHorizontal: 8, paddingVertical: 4 },
    headerBtnLabel: { fontSize: 13, fontWeight: '600' as const, color: colors.brand.primary },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'flex-end' as const,
    },
    sheet: {
      backgroundColor: colors.background.primary,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 20,
      paddingBottom: 32,
    },
    sheetTitle: { fontSize: 17, fontWeight: '700' as const, color: colors.text.primary, marginBottom: 4 },
    sheetSubtitle: { fontSize: 13, color: colors.text.secondary, marginBottom: 16 },
    sheetLabel: { fontSize: 13, fontWeight: '600' as const, color: colors.text.primary, marginTop: 12, marginBottom: 6 },
    sheetInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
    },
    abilityRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingVertical: 6,
    },
    abilityLabel: { fontSize: 14, color: colors.text.primary },
    scopeRow: { flexDirection: 'row' as const, marginTop: 4 },
    scopeChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border.default,
      marginRight: 8,
    },
    scopeChipActive: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
    scopeChipLabel: { fontSize: 13, color: colors.text.primary },
    scopeChipLabelActive: { color: colors.background.primary, fontWeight: '600' as const },
    sheetActions: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, marginTop: 20 },
    sheetBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginLeft: 8 },
    sheetBtnPrimary: { backgroundColor: colors.brand.primary },
    sheetBtnPrimaryDisabled: { backgroundColor: colors.border.strong },
    sheetBtnLabel: { fontSize: 14, color: colors.text.secondary },
    sheetBtnPrimaryLabel: { fontSize: 14, color: colors.background.primary, fontWeight: '600' as const },
    grantRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border.default,
    },
    grantId: { fontSize: 12, color: colors.text.secondary, flex: 1, marginRight: 12 },
    removeLabel: { fontSize: 13, fontWeight: '600' as const, color: colors.status.danger },
    bubbleTime: {
      fontSize: 10,
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
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === 'ios' ? 10 : 6,
      fontSize: 15,
      color: colors.text.primary,
      backgroundColor: colors.background.primary,
    },
    sendButton: {
      marginLeft: 8,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: { backgroundColor: colors.border.strong },
    sendLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
    attachButton: {
      marginRight: 8,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.background.tertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachLabel: { color: colors.text.primary, fontSize: 24 },
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

  const client = useOpenStoaClient();
  const host = useHost();
  // Pass the host secure store so MLS state persists across restarts (same leaf
  // restored, no re-join). Singleton: first caller (here or chatSocket) wins.
  const mls = getMlsSessionStore(client, host.secureStore, host.localStore);
  const tak = getTakSessionStore(client, host.secureStore, host.localStore);
  // TAK back-fill: recovered plaintext for pre-join messages MLS can't decrypt,
  // keyed by message id; merged into the list below. Topic visibility selects
  // the TAK tier (public root vs scoped) — resolved once on mount.
  const [recovered, setRecovered] = useState<Record<string, string>>({});
  const visibilityRef = useRef<Visibility>('public');
  // The caller's topic role — secret-tier history is granted only by the owner.
  const roleRef = useRef<string | null>(null);
  // Mirror the role into state so the owner-only AI controls re-render on load.
  const [role, setRole] = useState<string | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  // AI-grant + KeyPackage Delivery-Service surface over the authenticated client
  // (server is crypto-free — this only moves metadata + opaque public bytes).
  const aiDir = useMemo<AiMemberDirectory>(
    () => ({
      publishKeyPackage: (t, body) => client.post<{ id: string }>(`/api/topics/${t}/mls/key-packages`, body),
      createGrant: (t, spec) =>
        client.post<{ grant: { id: string } }>(`/api/topics/${t}/ai/grants`, spec).then((r) => ({ id: r.grant.id })),
      revokeGrant: (t, id) => client.delete(`/api/topics/${t}/ai/grants/${id}`).then(() => undefined),
    }),
    [client],
  );
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Local image viewer URL — avoids piping image taps through the
  // in-app WebView, which renders the raw image at top + blank space
  // (the "white area" reported on staging).
  const [imageViewerUrl, setImageViewerUrl] = useState<string | null>(null);

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
  const [catchupMessages, setCatchupMessages] = useState<ChatMessage[]>([]);
  // Optimistically-echoed own messages (plaintext). An MLS sender can't decrypt
  // its own sealed message, so without this the SSE echo shows "[unable to
  // decrypt]". Spread FIRST in the merge so it wins the first-wins dedup.
  const [sentMessages, setSentMessages] = useState<ChatMessage[]>([]);

  // ── Merge history + catchup + live, deduplicated, newest last ─────────────
  const allMessages = useMemo<ChatMessage[]>(() => {
    const historyMsgs = (data?.pages ?? []).flatMap((p) => p.messages);

    const seen = new Set<string>();
    const merged: ChatMessage[] = [];
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

  // ── TAK back-fill + public holder upkeep (Phase 3) ────────────────────────
  // On mount: resolve visibility, then back-fill (ingest bundles + decrypt the
  // archive) to recover pre-join history. For public topics, claim the single-
  // winner holder lease and, if held, distribute the archive root to all member
  // leaves so later joiners can read history. All best-effort — never blocks chat.
  const provisionArchiveAccess = useCallback(async () => {
    try {
      if (visibilityRef.current === 'public') {
        const deviceId = await tak.myDeviceId(topicId);
        await client.post(`/api/topics/${topicId}/tak/holder`, { deviceId }); // throws on 409 (not holder)
        await tak.distributePublicRoot(topicId);
      } else if (visibilityRef.current === 'private') {
        // SI-6b: explicit per-leaf grant of the epochs we hold; no custodian.
        await tak.grantPrivateHistory(topicId);
      } else if (visibilityRef.current === 'secret' && roleRef.current === 'owner') {
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
        if (v === 'public' || v === 'private' || v === 'secret') visibilityRef.current = v;
        roleRef.current = tj?.currentUserRole ?? null;
        setRole(tj?.currentUserRole ?? null);
      } catch {}
      try {
        const history = await tak.backfill(topicId, visibilityRef.current);
        if (!cancelled && history.length) {
          setRecovered((prev) => {
            const next = { ...prev };
            for (const h of history) next[h.messageId] = h.plaintext;
            return next;
          });
        }
      } catch {}
      if (!cancelled) await provisionArchiveAccess();
    })();
    return () => {
      cancelled = true;
    };
  }, [client, tak, topicId, provisionArchiveAccess]);

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
  useEffect(() => {
    if (allMessages.length === 0) return;
    const newest = allMessages[allMessages.length - 1];
    if (newest?.createdAt) setLastSeen(topicId, String(newest.createdAt));
  }, [allMessages, topicId]);

  // When SSE transitions to `open`, fetch any messages newer than what we
  // already have. Initial connect of a freshly-opened screen has nothing
  // newer to fetch; reconnect after a drop is the path that benefits.
  const prevSseStatusRef = useRef<typeof status>('idle');
  useEffect(() => {
    const prev = prevSseStatusRef.current;
    prevSseStatusRef.current = status;
    if (status !== 'open') return;
    const cursorIso = getLastSeen(topicId);
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

  // ── Presence + owner AI-agent header decoration ────────────────────────────
  const isOwnerRole = role === 'owner' || role === 'admin';
  useEffect(() => {
    navigation.setOptions({
      title: topicTitle,
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {isOwnerRole ? (
            <TouchableOpacity style={styles.headerBtn} onPress={() => setAiSheetOpen(true)} activeOpacity={0.7}>
              <Text style={styles.headerBtnLabel}>AI</Text>
            </TouchableOpacity>
          ) : null}
          {presence ? (
            <View style={styles.presenceBadge}>
              <View style={styles.presenceDot} />
              <Text style={styles.presenceCount}>{presence.count}</Text>
            </View>
          ) : null}
        </View>
      ),
    });
  }, [
    navigation,
    topicTitle,
    presence,
    isOwnerRole,
    styles.headerBtn,
    styles.headerBtnLabel,
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

  // ── Send message ──────────────────────────────────────────────────────────
  const send = useAuthGuardedAction(async () => {
    const text = draft.trim();
    if (!text || sending || !topicId) return;
    setSending(true);
    setDraft('');
    try {
      const sealed = await mls.seal(topicId, text);
      const res = await client.post<{ message: ChatMessage }>(`/api/topics/${topicId}/chat`, {
        ciphertext: sealed.ciphertext,
        epoch: sealed.epoch,
      });
      if (res?.message?.id) {
        setSentMessages((curr) =>
          curr.some((m) => m.id === res.message.id) ? curr : [...curr, { ...res.message, message: text }],
        );
        // Cache own plaintext so it survives a restart (sender can't self-decrypt).
        void mls.cachePlaintext(topicId, res.message.id, text);
        // Re-encrypt for the archive so later members can read it (Phase 3).
        void tak.archiveOnSend(topicId, res.message.id, text, visibilityRef.current).catch(() => {});
      }
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  });

  // ── Image attach helpers ──────────────────────────────────────────────────
  const uploadAndSend = useAuthGuardedAction(async (localUri: string) => {
    if (!topicId) return;
    setUploading(true);
    try {
      const publicUrl = await client.uploadFile(localUri);
      const sealed = await mls.seal(topicId, publicUrl);
      const res = await client.post<{ message: ChatMessage }>(`/api/topics/${topicId}/chat`, {
        ciphertext: sealed.ciphertext,
        epoch: sealed.epoch,
      });
      if (res?.message?.id) {
        setSentMessages((curr) =>
          curr.some((m) => m.id === res.message.id) ? curr : [...curr, { ...res.message, message: publicUrl }],
        );
        // Cache own plaintext so it survives a restart (sender can't self-decrypt).
        void mls.cachePlaintext(topicId, res.message.id, publicUrl);
        // Re-encrypt for the archive so later members can read it (Phase 3).
        void tak.archiveOnSend(topicId, res.message.id, publicUrl, visibilityRef.current).catch(() => {});
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Upload failed', msg);
    } finally {
      setUploading(false);
    }
  });

  const pickFromLibrary = useCallback(async () => {
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
    });
    if (result.canceled || !result.assets[0]) return;
    await uploadAndSend(result.assets[0].uri);
  }, [uploadAndSend]);

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
    const dataUri = await Clipboard.getImage();
    await uploadAndSend(dataUri);
  }, [uploadAndSend]);

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
      // KAV measures its OWN frame against the keyboard. The screen is
      // mounted under a stack header but the KAV starts BELOW it, so we
      // don't add a 88-px header offset here — doing so leaves an
      // 88-px gap above the keyboard (the bug user saw).
      keyboardVerticalOffset={0}
    >
      {/* Connection status bar */}
      {status === 'connecting' ? (
        <View style={styles.statusBar}>
          <ActivityIndicator size="small" color={colors.brand.primary} />
          <Text style={styles.statusText}> Connecting…</Text>
        </View>
      ) : null}
      {status === 'error' ? (
        <View style={[styles.statusBar, styles.statusError]}>
          <Text style={[styles.statusText, styles.statusErrorText]}>
            Disconnected{error ? `: ${error}` : ''}
          </Text>
        </View>
      ) : null}

      {/* Message list */}
      {isFirstLoad ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={allMessages}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <ChatMessageRow
              item={item}
              prevItem={index > 0 ? allMessages[index - 1] : undefined}
              styles={styles}
              navigation={navigation}
              client={client}
              onImagePress={setImageViewerUrl}
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
          editable={!sending}
          multiline
          returnKeyType="default"
          onSubmitEditing={send}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            (!draft.trim() || sending) && styles.sendButtonDisabled,
          ]}
          onPress={send}
          disabled={!draft.trim() || sending}
          activeOpacity={0.7}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.sendLabel}>{t('openstoa.chat.send')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
    <ImageViewerModal url={imageViewerUrl} onClose={() => setImageViewerUrl(null)} />
    <AiAgentSheet
      visible={aiSheetOpen}
      onClose={() => setAiSheetOpen(false)}
      topicId={topicId}
      client={client}
      dir={aiDir}
      mls={mls}
      tak={tak}
      styles={styles}
    />
    </>
  );
}

// ---------------------------------------------------------------------------
// ChatMessageRow
// ---------------------------------------------------------------------------

type Styles = ReturnType<typeof makeStyles>;

interface RowProps {
  item: ChatMessage;
  prevItem?: ChatMessage;
  styles: Styles;
  navigation: NativeStackNavigationProp<ChatStackParamList>;
  client: ReturnType<typeof useOpenStoaClient>;
  onImagePress: (url: string) => void;
}

function ChatMessageRow({ item, prevItem, styles, navigation, client, onImagePress }: RowProps) {
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

  const isOwn = item.userId === sessionUserId;

  return (
    <MessageBody
      item={item}
      sameAuthor={sameAuthor}
      isOwn={isOwn}
      styles={styles}
      navigation={navigation}
      client={client}
      onImagePress={onImagePress}
    />
  );
}

// ---------------------------------------------------------------------------
// MessageBody — handles URL detection, OG fetch, and link tapping
// ---------------------------------------------------------------------------

interface MessageBodyProps {
  item: ChatMessage;
  sameAuthor: boolean;
  isOwn: boolean;
  styles: Styles;
  navigation: NativeStackNavigationProp<ChatStackParamList>;
  client: ReturnType<typeof useOpenStoaClient>;
  onImagePress: (url: string) => void;
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

function MessageBody({ item, sameAuthor, isOwn, styles, navigation, client, onImagePress }: MessageBodyProps) {
  const content: string = item.message ?? '';
  const firstUrl = extractFirstUrl(content);
  const urlOnly = firstUrl !== null && isUrlOnly(content);
  // When the user pastes or uploads an image, the chat message body is just
  // the public URL. Render it as an inline image so it shows up like
  // Telegram/Slack instead of leaking the raw URL as text.
  const imageUrl = urlOnly && firstUrl && isImageUrl(firstUrl) ? firstUrl : null;

  const { data: ogData } = useQuery<OGData | null>({
    queryKey: ['og', firstUrl],
    queryFn: async () => {
      console.log('[OG] queryFn start', { firstUrl, urlOnly, imageUrl });
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
          const r = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(firstUrl)}&format=json`,
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
      } catch (e) {
        console.log('[OG] error', { firstUrl, msg: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
    // Skip OG fetch when the message is just an image URL (we render the
    // image directly) — saves a wasted server hit per image message.
    enabled: firstUrl !== null && !imageUrl,
    staleTime: 60 * 60 * 1000, // 1 hour
  });

  const hasOG = ogData != null && (ogData.title != null || ogData.image != null);

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
  const bodyStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextOther;
  const linkStyle = isOwn ? styles.linkOwn : styles.linkOther;

  return (
    <View style={styles.messageRow}>
      {/* Author name — other users only, first in group. AI members show a badge. */}
      {!isOwn && !sameAuthor ? (
        <View style={styles.bubbleAuthorRow}>
          <Text style={styles.bubbleAuthor}>{item.nickname}</Text>
          {item.isAI ? <Text style={styles.aiBadge}>AI</Text> : null}
        </View>
      ) : null}

      {/* Bubble row */}
      <View
        style={[
          styles.bubbleRow,
          isOwn ? styles.bubbleRowOwn : styles.bubbleRowOther,
        ]}
      >
        {/* Timestamp left of bubble for own messages */}
        {isOwn && !sameAuthor ? (
          <Text style={[styles.bubbleTime, styles.bubbleTimeOwn]}>{timeLabel}</Text>
        ) : null}

        {/* Inline image — when the message is just an image URL render
            the picture in place of the text bubble (Telegram-style). */}
        {imageUrl ? (
          <TouchableOpacity
            activeOpacity={0.85}
            // Open in a local image viewer instead of the in-app WebView —
            // the WebView renders the raw image with a blank page below.
            onPress={() => onImagePress(imageUrl)}
            style={isOwn ? styles.bubbleOGWrapOwn : styles.bubbleOGWrapOther}
          >
            <Image
              source={{ uri: imageUrl }}
              style={{
                width: 220,
                height: 220,
                borderRadius: 12,
                backgroundColor: 'rgba(255,255,255,0.05)',
              }}
              resizeMode="cover"
            />
          </TouchableOpacity>
        ) : null}

        {/* Bubble — hidden when URL-only + image rendered OR OG card present */}
        {(!urlOnly || (!hasOG && !imageUrl)) && !imageUrl ? (
          <View
            style={[
              styles.bubble,
              isOwn ? styles.bubbleOwn : styles.bubbleOther,
            ]}
          >
            <Text style={bodyStyle}>
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
          </View>
        ) : null}

        {/* Timestamp right of bubble for other users */}
        {!isOwn && !sameAuthor ? (
          <Text style={[styles.bubbleTime, styles.bubbleTimeOther]}>{timeLabel}</Text>
        ) : null}
      </View>

      {/* OG preview card */}
      {hasOG && firstUrl ? (
        <View style={isOwn ? styles.bubbleOGWrapOwn : styles.bubbleOGWrapOther}>
          <OGPreviewCard
            url={firstUrl}
            data={ogData!}
            onPress={() => openUrl(firstUrl)}
          />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// AiAgentSheet — owner consent surface to add / remove an AI member (design §7)
// ---------------------------------------------------------------------------

// Ability allowlist offered in the consent sheet (subset of the server's
// ALLOWED_CMDS). Defaults follow the task: chat read + send + summarize.
const AI_ABILITIES: { cmd: string; label: string; default: boolean }[] = [
  { cmd: '/openstoa/chat/read', label: 'Read chat', default: true },
  { cmd: '/openstoa/chat/send', label: 'Send messages', default: true },
  { cmd: '/ai/summarize', label: 'Summarize', default: true },
  { cmd: '/openstoa/post/read', label: 'Read posts', default: false },
];
type HistoryScope = 'none' | '30d' | 'full';
const SCOPES: { key: HistoryScope; label: string }[] = [
  { key: 'none', label: 'No history' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'full', label: 'Full history' },
];

interface AiGrantWire {
  id: string;
  aiUserId: string;
  cmd: string[];
  historyGrant: string;
}

interface AiAgentSheetProps {
  visible: boolean;
  onClose: () => void;
  topicId: string;
  client: ReturnType<typeof useOpenStoaClient>;
  dir: AiMemberDirectory;
  mls: MlsSessionStore;
  tak: TakSessionStore;
  styles: Styles;
}

function AiAgentSheet({ visible, onClose, topicId, client, dir, mls, tak, styles }: AiAgentSheetProps) {
  const [aiUserId, setAiUserId] = useState('');
  const [abilities, setAbilities] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(AI_ABILITIES.map((a) => [a.cmd, a.default])),
  );
  const [scope, setScope] = useState<HistoryScope>('30d');
  const [grants, setGrants] = useState<AiGrantWire[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshGrants = useCallback(async () => {
    try {
      const r = await client.get<{ grants: AiGrantWire[] }>(`/api/topics/${topicId}/ai/grants`);
      setGrants(r.grants ?? []);
    } catch {
      /* non-fatal — the list just stays empty */
    }
  }, [client, topicId]);

  useEffect(() => {
    if (visible) void refreshGrants();
  }, [visible, refreshGrants]);

  // Resolve the chosen history scope → the epochs to hand the bot. The
  // epoch↔time map comes from the archive rows themselves (tak_version = epoch,
  // created_at ≈ send time). `none` grants nothing; `full` grants every archived
  // epoch; `30d` only epochs with in-window archives. grantScoped then sends only
  // the epochs the owner actually holds — anything else stays unreadable.
  const resolveScopeEpochs = useCallback(
    async (s: HistoryScope): Promise<number[]> => {
      if (s === 'none') return [];
      const rows = await client
        .get<{ archive: { takVersion: number; createdAt: string }[] }>(`/api/topics/${topicId}/archive?limit=500`)
        .then((r) => r.archive)
        .catch(() => [] as { takVersion: number; createdAt: string }[]);
      const cutoff = s === '30d' ? Date.now() - 30 * 86_400_000 : -Infinity;
      const epochs = new Set<number>();
      for (const r of rows) if (Date.parse(r.createdAt) >= cutoff) epochs.add(r.takVersion);
      return [...epochs];
    },
    [client, topicId],
  );

  const onAdd = useCallback(async () => {
    const id = aiUserId.trim();
    if (!id || busy) return;
    const cmd = AI_ABILITIES.filter((a) => abilities[a.cmd]).map((a) => a.cmd);
    if (cmd.length === 0) {
      Alert.alert('Pick at least one ability');
      return;
    }
    setBusy(true);
    try {
      // Consent (D9): create the UCAN-shaped grant. The AI's MLS credential
      // identity is its user id, so the same id targets the scoped TAK + Remove.
      const spec: AiGrantSpec = { aiUserId: id, cmd, historyGrant: scope === 'none' ? 'none' : scope === '30d' ? '30d' : 'full' };
      await grantAiConsent(dir, topicId, spec);
      // Deliver the in-scope epoch TAKs to the bot's leaf (out-of-scope omitted).
      const epochs = await resolveScopeEpochs(scope);
      if (epochs.length) await grantAiHistory(tak, topicId, id, epochs).catch(() => 0);
      setAiUserId('');
      await refreshGrants();
    } catch (err) {
      Alert.alert('Add AI agent failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [aiUserId, abilities, scope, busy, dir, tak, topicId, resolveScopeEpochs, refreshGrants]);

  const onRemove = useCallback(
    async (grant: AiGrantWire) => {
      setBusy(true);
      try {
        // Revoke (D11): grant DELETE (immediate access-gate) + MLS Remove
        // Commit (excludes the bot from future epochs). Already-delivered
        // plaintext is not cryptographically revocable — future access only.
        await removeAiMember(mls, dir, topicId, grant.aiUserId, grant.id).catch(async (e) => {
          // If the bot never joined the MLS group there is no leaf to remove;
          // still ensure the grant is revoked so the access-gate closes.
          await dir.revokeGrant(topicId, grant.id).catch(() => {});
          throw e;
        });
      } catch {
        /* revoke already attempted; surface nothing further */
      } finally {
        await refreshGrants();
        setBusy(false);
      }
    },
    [mls, dir, topicId, refreshGrants],
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1} onPress={() => {}}>
          <Text style={styles.sheetTitle}>Add AI agent</Text>
          <Text style={styles.sheetSubtitle}>
            The agent joins with its own key and acts only within the abilities you grant.
          </Text>

          <Text style={styles.sheetLabel}>AI agent ID</Text>
          <TextInput
            style={styles.sheetInput}
            placeholder="0x… (the agent's user id)"
            value={aiUserId}
            onChangeText={setAiUserId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <Text style={styles.sheetLabel}>Abilities</Text>
          {AI_ABILITIES.map((a) => (
            <View key={a.cmd} style={styles.abilityRow}>
              <Text style={styles.abilityLabel}>{a.label}</Text>
              <Switch
                value={!!abilities[a.cmd]}
                onValueChange={(v) => setAbilities((prev) => ({ ...prev, [a.cmd]: v }))}
                disabled={busy}
              />
            </View>
          ))}

          <Text style={styles.sheetLabel}>History access</Text>
          <View style={styles.scopeRow}>
            {SCOPES.map((s) => {
              const active = scope === s.key;
              return (
                <TouchableOpacity
                  key={s.key}
                  style={[styles.scopeChip, active && styles.scopeChipActive]}
                  onPress={() => setScope(s.key)}
                  disabled={busy}
                >
                  <Text style={[styles.scopeChipLabel, active && styles.scopeChipLabelActive]}>{s.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {grants.length > 0 ? (
            <>
              <Text style={styles.sheetLabel}>Active AI agents</Text>
              {grants.map((g) => (
                <View key={g.id} style={styles.grantRow}>
                  <Text style={styles.grantId} numberOfLines={1}>
                    {g.aiUserId}
                  </Text>
                  <TouchableOpacity onPress={() => onRemove(g)} disabled={busy}>
                    <Text style={styles.removeLabel}>Remove AI</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          ) : null}

          <View style={styles.sheetActions}>
            <TouchableOpacity style={styles.sheetBtn} onPress={onClose} disabled={busy}>
              <Text style={styles.sheetBtnLabel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sheetBtn, styles.sheetBtnPrimary, (busy || !aiUserId.trim()) && styles.sheetBtnPrimaryDisabled]}
              onPress={onAdd}
              disabled={busy || !aiUserId.trim()}
            >
              {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.sheetBtnPrimaryLabel}>Add</Text>}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
