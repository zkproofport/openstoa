'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';
import Badge from '@/components/Badge';
import LinkPreview from '@/components/LinkPreview';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import { getMlsSessionStore, getTakSessionStore } from '@/lib/mls/webTransport';
import type { Visibility } from '@/lib/mls/takSession';
import {
  DecryptOnce,
  fetchCatchup,
  mergeChronological,
  newestCreatedAt,
  sinceCursor,
  CATCHUP_PAGE_LIMIT,
  HISTORY_PAGE_LIMIT,
} from '@/lib/chatSync';

// The panel is a client component but Next still renders it once on the server,
// where useLayoutEffect warns. The scroll-anchor restore must run before paint
// (a useEffect would show one frame at the wrong offset), so pick per platform.
const useBrowserLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Server rows for user messages carry an encrypted `sealed` body, not plaintext.
// Decrypt for local display so MessageRow keeps rendering `msg.message` as text.
// System rows (join/leave) carry plaintext `message` and pass through unchanged.
interface RawChatMessage {
  id?: string;
  type?: string;
  sealed?: { ciphertext: string; epoch: number } | null;
  message?: string;
  createdAt?: string;
}

async function toDisplayMessage(
  topicId: string,
  raw: RawChatMessage,
  // Plaintext of messages THIS panel just sent, keyed by sealed ciphertext.
  // Consulted before any MLS work — see `pendingSendsRef`.
  pendingSends?: Map<string, string>,
): Promise<ChatMessage> {
  if (raw?.type === 'message') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      // An MLS sender can NEVER decrypt its own application message (its send
      // ratchet has already advanced). The SSE echo of a message we just sent
      // can outrun the POST response that carries the server-assigned id, so
      // resolve it from the plaintext we still hold rather than attempting a
      // decrypt that is guaranteed to fail. Without this the echo resolves to
      // '[unable to decrypt]' and the id-dedupe below then KEEPS that row.
      const own = pendingSends?.get(raw.sealed.ciphertext);
      if (own != null) {
        text = own;
      } else {
        try {
          // openCached: MLS keys are consumed on first decrypt (forward secrecy),
          // so cache the plaintext by id → history survives reloads/restarts.
          const opened = raw.id
            ? await getMlsSessionStore().openCached(topicId, raw.id, raw.sealed)
            : await getMlsSessionStore().open(topicId, raw.sealed);
          text = opened ?? '[unable to decrypt]';
        } catch {
          text = '[unable to decrypt]';
        }
      }
    }
    return { ...(raw as ChatMessage), message: text };
  }
  return raw as ChatMessage;
}

// Match the mobile chat URL detector (ChatRoomScreen.tsx). Keep them in
// sync so the same message renders an OG card on both surfaces.
const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i;

function extractFirstUrl(text: string): string | null {
  URL_REGEX.lastIndex = 0;
  const m = URL_REGEX.exec(text);
  URL_REGEX.lastIndex = 0;
  return m ? m[1] : null;
}

function isUrlOnly(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

// Same heuristic as mobile: extension or media.zkproofport.app host.
function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  try {
    return new URL(url).hostname.endsWith('media.zkproofport.app');
  } catch {
    return false;
  }
}

// Render plain text with embedded URLs turned into clickable links.
// `linkColor` differs inside an own-message bubble, where the accent-on-accent
// link would be unreadable (mobile does the same — `linkOwn` vs `linkOther`).
function renderLinkedText(text: string, linkColor = 'var(--accent)'): React.ReactNode {
  URL_REGEX.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    out.push(
      <a
        key={start}
        href={match[1]}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: linkColor, textDecoration: 'underline', wordBreak: 'break-all' }}
      >
        {match[1]}
      </a>,
    );
    lastIndex = start + match[1].length;
  }
  URL_REGEX.lastIndex = 0;
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PresenceUser {
  userId: string;
  nickname: string;
  profileImage?: string;
  connectedAt: string;
}

interface ChatMessage {
  id: string;
  topicId: string;
  userId: string;
  nickname: string;
  profileImage?: string;
  message: string;
  type: 'message' | 'join' | 'leave';
  isAI?: boolean;
  createdAt: string;
}

interface ChatPanelProps {
  /** Roomier type scale + spacing — used by the chat rail (a wide column) and
   *  the full-screen mobile sheet / standalone `/chat/[id]` and `/dm/[id]`
   *  pages, where the docked panel's compact scale would look cramped. */
  roomy?: boolean;
  topicId: string;
  isGuest: boolean;
  isMember: boolean;
  /** When true, panel fills its parent height (used in mobile full-screen) */
  fullHeight?: boolean;
  /** Hide the header (used when parent provides its own header) */
  hideHeader?: boolean;
  /** Close handler for mobile overlay */
  onClose?: () => void;
  /** Keep the card chrome (surface + border) while still filling the parent
   *  height — used by the docked desktop chat column. */
  framed?: boolean;
  /** Topic name for the header. Falls back to the generic "Live Chat" label. */
  title?: string;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  marginBottom: 12,
  overflow: 'hidden',
};

const panelFullHeightStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
};

// Docked chat column: fills the sidebar height but keeps the card chrome so it
// reads as part of the same surface family as the other sidebar cards.
const panelFramedFullHeightStyle: React.CSSProperties = {
  ...panelFullHeightStyle,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const headerLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--muted)',
};

const onlineCountStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  marginLeft: 4,
};

const messagesContainerStyle: React.CSSProperties = {
  maxHeight: 400,
  overflowY: 'auto' as const,
  padding: '10px 14px',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
};

// ─── Avatar dots component ────────────────────────────────────────────────────

function PresenceDots({ users, max = 5 }: { users: PresenceUser[]; max?: number }) {
  const shown = users.slice(0, max);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {shown.map((u) =>
        u.profileImage ? (
          <img
            key={u.userId}
            src={u.profileImage}
            alt={u.nickname}
            title={u.nickname}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              objectFit: 'cover',
              border: '1px solid var(--border)',
            }}
          />
        ) : (
          <div
            key={u.userId}
            title={u.nickname}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              fontWeight: 700,
              color: '#fff',
              border: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {u.nickname.charAt(0).toUpperCase()}
          </div>
        )
      )}
      {users.length > max && (
        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>
          +{users.length - max}
        </span>
      )}
    </div>
  );
}

// ─── Message row ──────────────────────────────────────────────────────────────

function MessageRow({ msg, grouped, roomy, own }: { msg: ChatMessage; grouped?: boolean; roomy?: boolean; own?: boolean }) {
  // System rows are about the room, not about a person — centered on both
  // surfaces so they never read as somebody's message.
  if (msg.type === 'join' || msg.type === 'leave') {
    return (
      <div style={{
        fontSize: roomy ? 12 : 11,
        color: 'var(--muted)',
        fontStyle: 'italic',
        padding: '2px 0',
        lineHeight: 1.4,
        textAlign: 'center' as const,
      }}>
        {msg.nickname} {msg.type === 'join' ? 'entered the chat' : 'left the chat'}
      </div>
    );
  }

  const firstUrl = extractFirstUrl(msg.message);
  const urlOnly = firstUrl !== null && isUrlOnly(msg.message);
  const inlineImage = urlOnly && firstUrl && isImageUrl(firstUrl) ? firstUrl : null;
  // When the message is JUST a URL we let the OG card (or inline image)
  // carry it on its own — repeating the URL above the card is the same
  // visual noise mobile already avoids.
  const hideMessageText = urlOnly && (inlineImage !== null || firstUrl !== null);

  // Bubble treatment mirrors mobile (ChatRoomScreen `bubbleOwn`/`bubbleOther`):
  // own messages sit right in an accent bubble, everyone else left on a neutral
  // surface, with the tail corner squared off on the speaker's side.
  const timestamp = !grouped && (
    <span style={{
      fontSize: 10,
      fontFamily: 'var(--font-mono)',
      color: 'var(--muted)',
      flexShrink: 0,
      paddingBottom: 2,
    }}>
      {relativeTime(msg.createdAt)}
    </span>
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: own ? 'flex-end' : 'flex-start',
      lineHeight: roomy ? 1.5 : 1.4,
      marginTop: grouped ? -2 : 0,
      maxWidth: '100%',
    }}>
      {/* Author — other people only, first message of a group (mobile parity). */}
      {!own && !grouped && (
        <span style={{
          fontSize: roomy ? 13 : 12,
          fontWeight: 700,
          color: 'var(--accent)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          marginBottom: 2,
          paddingLeft: 2,
        }}>
          {msg.nickname}
          {msg.isAI && <Badge type="ai" />}
        </span>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
        maxWidth: '85%',
        // Timestamp sits on the outside of the bubble on both surfaces: left of
        // an own bubble, right of someone else's (mobile `bubbleTimeOwn/Other`).
        // The column's alignItems already packs the row to the correct edge.
        flexDirection: own ? 'row' : 'row-reverse',
      }}>
        {timestamp}
        {!hideMessageText && (
          <span style={{
            fontSize: roomy ? 14 : 13,
            color: own ? '#fff' : 'var(--foreground)',
            background: own ? 'var(--accent)' : 'rgba(255,255,255,0.055)',
            borderRadius: 14,
            ...(own ? { borderBottomRightRadius: 4 } : { borderBottomLeftRadius: 4 }),
            padding: roomy ? '8px 12px' : '6px 10px',
            wordBreak: 'break-word' as const,
            minWidth: 0,
          }}>
            {renderLinkedText(msg.message, own ? 'rgba(255,255,255,0.95)' : 'var(--accent)')}
          </span>
        )}
      </div>

      {inlineImage && (
        <a
          href={inlineImage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'block', marginTop: 4, maxWidth: '85%' }}
        >
          <img
            src={inlineImage}
            alt=""
            style={{
              maxWidth: '100%',
              maxHeight: roomy ? 380 : 240,
              borderRadius: 12,
              border: '1px solid var(--border)',
              display: 'block',
            }}
          />
        </a>
      )}
      {firstUrl && !inlineImage && (
        <div style={{ marginTop: 6, marginBottom: 2, maxWidth: '85%' }}>
          <LinkPreview url={firstUrl} />
        </div>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChatPanel({
  topicId,
  isGuest,
  isMember,
  fullHeight,
  hideHeader,
  onClose,
  roomy = false,
  framed,
  title,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<{ users: PresenceUser[]; count: number }>({ users: [], count: 0 });
  const [connected, setConnected] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Own-message alignment needs the caller's id. Same source the rest of the
  // web app uses for "is this me" checks (see topics/[topicId]/members).
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // ── History paging (`?before=`) ────────────────────────────────────────────
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Ref mirrors of the two flags above: the scroll handler fires many times per
  // frame and must not act on a state value React has not committed yet.
  const hasMoreHistoryRef = useRef(false);
  const loadingOlderRef = useRef(false);
  /** id of the oldest row on screen — the `?before=` cursor. */
  const oldestIdRef = useRef<string | null>(null);

  // ── Reconnect catch-up (`?since=`) ─────────────────────────────────────────
  /** createdAt of the newest row we have ingested — the `?since=` cursor. */
  const lastSeenIsoRef = useRef<string | null>(null);
  /** False until the SSE stream has opened once; the FIRST open has nothing to
   *  catch up on (the history fetch covers it), every later one does. */
  const hasConnectedRef = useRef(false);
  const catchupRunningRef = useRef(false);

  // ── Scroll bookkeeping ─────────────────────────────────────────────────────
  /** Distance from the bottom captured just before older messages prepend. */
  const pendingScrollAnchorRef = useRef<number | null>(null);
  const userNearBottomRef = useRef(true);
  const initialScrolledRef = useRef(false);
  const lastBottomIdRef = useRef<string | null>(null);

  /**
   * One decrypt per message id, forever — the panel's central correctness
   * guard. History, `?before=` pages, `?since=` catch-up and the SSE stream all
   * funnel through `ingest`, so a message delivered by two of them at once
   * awaits ONE decrypt instead of racing MLS, whose per-message key is consumed
   * on first use (the loser of that race renders `[unable to decrypt]` forever).
   */
  const decryptOnceRef = useRef(new DecryptOnce<ChatMessage>());
  // Topic visibility drives the TAK tier (public root vs scoped per-epoch).
  // Resolved once per topic in the history effect; defaults to public.
  const visibilityRef = useRef<Visibility>('public');
  // The caller's topic role — secret-tier history is granted only by the owner.
  const roleRef = useRef<string | null>(null);
  // Plaintext of messages sent from THIS panel, keyed by the sealed ciphertext
  // (known at seal() time, i.e. before the POST is even issued). The SSE echo
  // carries the same ciphertext, so this resolves our own messages without an
  // MLS open — which a sender can never satisfy. Bounded so a long session
  // cannot grow it without limit.
  const pendingSendsRef = useRef(new Map<string, string>());

  const rememberOwnPlaintext = useCallback((ciphertext: string, plaintext: string) => {
    const m = pendingSendsRef.current;
    m.set(ciphertext, plaintext);
    while (m.size > 200) m.delete(m.keys().next().value as string);
  }, []);

  /**
   * Turn raw server rows into display rows, decrypting each id at most once.
   *
   * Every delivery path calls this — there is deliberately no other route from
   * a wire row to the message list. A row whose decrypt throws outright (a
   * broken key store, not just an undecryptable body) degrades to a single
   * `[unable to decrypt]` row: `Promise.all` would otherwise reject and blank
   * the entire page it was part of.
   */
  const ingest = useCallback(
    (raws: RawChatMessage[]): Promise<ChatMessage[]> =>
      Promise.all(
        raws.map((raw) => {
          const decrypt = () =>
            toDisplayMessage(topicId, raw, pendingSendsRef.current).catch(
              () => ({ ...(raw as unknown as ChatMessage), message: '[unable to decrypt]' }),
            );
          return raw?.id ? decryptOnceRef.current.get(raw.id, decrypt) : decrypt();
        }),
      ),
    [topicId],
  );

  /**
   * Merge decrypted rows into the list and advance the `?since=` cursor.
   * Safe to call with rows that are already on screen (dedupe by id) and with
   * rows older than everything on screen (the merge sorts chronologically), so
   * catch-up, live and history paging share one path.
   */
  const applyIncoming = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => mergeChronological(prev, incoming));
    const newest = newestCreatedAt(incoming);
    // Older pages must never rewind the catch-up cursor.
    if (newest && (!lastSeenIsoRef.current || new Date(newest) > new Date(lastSeenIsoRef.current))) {
      lastSeenIsoRef.current = newest;
    }
  }, []);

  // Seal the push-preview copy (design §13.6 strategy A) so the recipient's iOS
  // NSE has something it can decrypt without consuming an MLS ratchet key. Sent
  // INSIDE the POST because push fan-out happens there — the separate
  // archiveOnSend upload only lands after the response. Best-effort: any failure
  // just omits the field and the recipient gets the content-free push.
  const buildPushArchive = useCallback(async (text: string) => {
    const seal = await getTakSessionStore().sealForPush(topicId, text, visibilityRef.current).catch(() => null);
    return seal ? { ct: seal.ct, takVersion: seal.takVersion } : undefined;
  }, [topicId]);

  // Uploads via /api/upload and posts the returned URL as a chat message.
  // The message body is the bare URL — MessageRow's isImageUrl detection
  // renders it inline, matching the mobile chat UX.
  const sendImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!up.ok) throw new Error('upload failed');
      // The endpoint returns `{ publicUrl: ... }` (see app/api/upload/route.ts).
      const { publicUrl } = await up.json();
      if (!publicUrl) throw new Error('no url');
      const sealed = await getMlsSessionStore().seal(topicId, publicUrl);
      rememberOwnPlaintext(sealed.ciphertext, publicUrl);
      const pushArchive = await buildPushArchive(publicUrl);
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
      });
      // Optimistic local echo (sender can't decrypt its own MLS message).
      if (res.ok) {
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            const own: ChatMessage = { ...payload, message: publicUrl };
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, own);
            applyIncoming([own]);
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, publicUrl);
            // Re-encrypt for the archive so later members can read it (Phase 3).
            // Fire-and-forget: an archive failure must never break sending.
            void getTakSessionStore().archiveOnSend(topicId, payload.id, publicUrl, visibilityRef.current).catch(() => {});
          }
        } catch {}
      }
    } catch {
      // best-effort; the user can retry
    } finally {
      setUploading(false);
    }
  }, [topicId, buildPushArchive, rememberOwnPlaintext]);

  async function handleSend() {
    const text = inputValue.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const sealed = await getMlsSessionStore().seal(topicId, text);
      rememberOwnPlaintext(sealed.ciphertext, text);
      const pushArchive = await buildPushArchive(text);
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
      });
      if (res.ok) {
        // Optimistic local echo: an MLS sender cannot decrypt its own sealed
        // message (the sender ratchet has advanced), so show the known
        // plaintext directly. The SSE echo carries the same id and dedupes.
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            const own: ChatMessage = { ...payload, message: text };
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, own);
            applyIncoming([own]);
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, text);
            // Re-encrypt for the archive so later members can read it (Phase 3).
            void getTakSessionStore().archiveOnSend(topicId, payload.id, text, visibilityRef.current).catch(() => {});
          }
        } catch {}
        setInputValue('');
        inputRef.current?.focus();
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  useEffect(() => {
    if (isGuest) return;
    let alive = true;
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.userId) setMyUserId(d.userId); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isGuest]);

  /**
   * Scroll the message list to the bottom.
   *
   * Scrolls `scrollerRef` DIRECTLY rather than calling `scrollIntoView` on the
   * bottom sentinel. `scrollIntoView` walks up and scrolls EVERY scrollable
   * ancestor, including the document — so once the panel became a normal flex
   * child of the page (the chat rail) instead of a `position: fixed` layer,
   * opening a room yanked the whole page down with it. Setting `scrollTop` on
   * the panel's own scroller cannot move anything outside the panel.
   *
   * `smooth` only for messages arriving while the user is already at the
   * bottom; entering a room jumps instantly, since animating a scroll the user
   * never initiated is what reads as the page "running away".
   */
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /**
   * Load one page of older history (`?before=<oldest id>`).
   *
   * Cursor is a message id, not an offset, so messages arriving while the page
   * is in flight cannot shift the window and cause a skip or a duplicate. The
   * in-flight guard is a ref, not the `loadingOlder` state: the scroll handler
   * can fire again before React commits.
   */
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreHistoryRef.current) return;
    const cursor = oldestIdRef.current;
    if (!cursor) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    // Anchor on the distance from the BOTTOM: prepending grows scrollHeight, so
    // restoring this distance keeps the row the user is reading under the cursor.
    const el = scrollerRef.current;
    pendingScrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    try {
      const res = await fetch(
        `/api/topics/${topicId}/chat?limit=${HISTORY_PAGE_LIMIT}&before=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = await res.json();
      const raws: RawChatMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      // A short page means we reached the beginning of the topic — stop asking.
      const more = raws.length >= HISTORY_PAGE_LIMIT;
      const decrypted = await ingest(raws);
      if (!mountedRef.current) return;
      if (decrypted.length === 0) pendingScrollAnchorRef.current = null;
      applyIncoming(decrypted);
      hasMoreHistoryRef.current = more;
      setHasMoreHistory(more);
    } catch {
      // Transient failure: keep `hasMoreHistory` so the user can retry.
      pendingScrollAnchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }, [topicId, ingest, applyIncoming]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      // "Near bottom" decides whether an incoming message may steal the scroll
      // position from someone reading history further up.
      userNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (el.scrollTop < 80) void loadOlder();
    },
    [loadOlder],
  );

  // Restore the scroll position BEFORE paint whenever a page of older messages
  // was just prepended. Runs ahead of the auto-scroll effect below (layout
  // effects flush first), so the two never fight.
  useBrowserLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (anchor == null) return;
    pendingScrollAnchorRef.current = null;
    const el = scrollerRef.current;
    if (el) el.scrollTop = Math.max(0, el.scrollHeight - anchor);
  }, [messages]);

  // Auto-scroll only when the BOTTOM of the list moved (a new message), never
  // when older history prepended — and only if the user was already at the
  // bottom, so reading history is not interrupted by someone else typing.
  useEffect(() => {
    oldestIdRef.current = messages.length > 0 ? messages[0].id : null;
    const bottomId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (bottomId === lastBottomIdRef.current) return;
    lastBottomIdRef.current = bottomId;
    if (!bottomId) return;
    if (!initialScrolledRef.current || userNearBottomRef.current) {
      const isFirstPaint = !initialScrolledRef.current;
      initialScrolledRef.current = true;
      scrollToBottom(!isFirstPaint);
    }
  }, [messages, scrollToBottom]);

  // Provision archive access for later members, by tier. public: claim the
  // single-winner holder lease (409 = someone else holds it, no-op) and the
  // winner distributes the root to all leaves (SI-6). private: explicitly grant
  // the epochs we hold to new member leaves (SI-6b — no custodian/lease). secret:
  // nothing (the owner grants explicitly). Best-effort — never throws into chat.
  const provisionArchiveAccess = useCallback(async () => {
    try {
      const tak = getTakSessionStore();
      if (visibilityRef.current === 'public') {
        const deviceId = await tak.myDeviceId(topicId);
        const r = await fetch(`/api/topics/${topicId}/tak/holder`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId }),
        });
        if (r.ok) await tak.distributePublicRoot(topicId);
      } else if (visibilityRef.current === 'private') {
        await tak.grantPrivateHistory(topicId);
      } else if (visibilityRef.current === 'secret' && roleRef.current === 'owner') {
        // secret: no auto-grant by default — only the owner shares history.
        await tak.grantPrivateHistory(topicId);
      }
    } catch {}
  }, [topicId]);

  useEffect(() => {
    if (isGuest || !isMember) return;

    mountedRef.current = true;

    // Switching topics must not carry ANY of the previous room across: its
    // messages, its decrypt memo (ids are unique per message, but a stale memo
    // just wastes memory), its catch-up cursor, or its paging cursor.
    setMessages([]);
    setHasMoreHistory(false);
    hasMoreHistoryRef.current = false;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    decryptOnceRef.current = new DecryptOnce<ChatMessage>();
    lastSeenIsoRef.current = null;
    oldestIdRef.current = null;
    lastBottomIdRef.current = null;
    hasConnectedRef.current = false;
    catchupRunningRef.current = false;
    pendingScrollAnchorRef.current = null;
    initialScrolledRef.current = false;
    userNearBottomRef.current = true;

    // Fetch history, then TAK back-fill pre-join messages (Phase 3).
    (async () => {
      // Resolve the topic's visibility once → selects the TAK tier. Best-effort:
      // default 'public' if the lookup fails.
      try {
        const tr = await fetch(`/api/topics/${topicId}`, { credentials: 'include' });
        if (tr.ok) {
          const tj = await tr.json();
          const v = (tj?.topic?.visibility ?? tj?.visibility) as Visibility | undefined;
          if (v === 'public' || v === 'private' || v === 'secret') visibilityRef.current = v;
          roleRef.current = (tj?.currentUserRole as string | null) ?? null;
        }
      } catch {}

      const data = await fetch(`/api/topics/${topicId}/chat?limit=${HISTORY_PAGE_LIMIT}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!mountedRef.current || !Array.isArray(data?.messages)) return;
      const raws = data.messages as RawChatMessage[];
      // A full first page means older messages exist behind it; a short one
      // means this topic's entire history already fits on screen.
      const more = raws.length >= HISTORY_PAGE_LIMIT;
      const decrypted = await ingest(raws);
      if (!mountedRef.current) return;
      // Server returns newest-first here; the merge sorts, so no reverse needed.
      applyIncoming(decrypted);
      hasMoreHistoryRef.current = more;
      setHasMoreHistory(more);

      // Back-fill: fetch TAK bundles + archive, decrypt history MLS forward
      // secrecy locked out, and fill in any '[unable to decrypt]' rows. Entirely
      // best-effort — never blocks or breaks the live chat.
      try {
        const recovered = await getTakSessionStore().backfill(topicId, visibilityRef.current);
        if (mountedRef.current && recovered.length) {
          const byId = new Map(recovered.map((r) => [r.messageId, r.plaintext]));
          setMessages((prev) =>
            prev.map((m) =>
              m.message === '[unable to decrypt]' && byId.has(m.id) ? { ...m, message: byId.get(m.id)! } : m,
            ),
          );
        }
      } catch {}

      // Public holder upkeep (SI-6): claim the lease and, if we hold it,
      // distribute the archive root to every current member leaf so later
      // joiners can read history. Single-winner on the server; idempotent for
      // recipients. Custodian-free tiers (private/secret) skip this by design.
      void provisionArchiveAccess();
    })();

    /**
     * Pull everything that arrived while the stream was down.
     *
     * The SSE subscription only delivers events that happen after it is live,
     * so every message written during a drop is invisible until a reload —
     * which is exactly what this closes. Idempotent by construction: rows the
     * stream also delivers are deduped by id and decrypted once (`ingest`), so
     * running catch-up and receiving the same message live is harmless.
     */
    async function runCatchup() {
      const anchor = lastSeenIsoRef.current;
      // No anchor = we have never seen a message, so there is no delta to sync
      // against; the initial history fetch is the complete picture.
      if (!anchor || catchupRunningRef.current) return;
      catchupRunningRef.current = true;
      try {
        const raws = await fetchCatchup<RawChatMessage & { id: string; createdAt: string }>({
          sinceIso: sinceCursor(anchor),
          fetchPage: async (since, limit) => {
            const r = await fetch(
              `/api/topics/${topicId}/chat?limit=${limit}&since=${encodeURIComponent(since)}`,
            );
            if (!r.ok) throw new Error(`catchup ${r.status}`);
            const d = await r.json();
            return Array.isArray(d?.messages) ? d.messages : [];
          },
          limit: CATCHUP_PAGE_LIMIT,
        });
        if (!mountedRef.current || raws.length === 0) return;
        const decrypted = await ingest(raws);
        if (!mountedRef.current) return;
        applyIncoming(decrypted);
      } catch {
        // Best-effort: the next reconnect retries from the same cursor, and the
        // cursor only advances on messages we actually ingested.
      } finally {
        catchupRunningRef.current = false;
      }
    }

    function connect() {
      if (!mountedRef.current) return;

      const es = new EventSource(`/api/topics/${topicId}/chat/subscribe`);
      esRef.current = es;

      es.addEventListener('presence', (e) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(e.data);
          setPresence({ users: data.users ?? [], count: data.count ?? 0 });
        } catch {}
      });

      es.addEventListener('message', (e) => {
        if (!mountedRef.current) return;
        try {
          const raw = JSON.parse(e.data);
          // A new member joined → if we hold the public archive lease, push them
          // the root so they can back-fill history (SI-6, membership change).
          if (raw?.type === 'join') void provisionArchiveAccess();
          // Decrypt the sealed body before display. Goes through the same
          // one-decrypt-per-id funnel as catch-up, so a message delivered by
          // both paths is opened once and rendered once.
          void ingest([raw]).then((msgs) => {
            if (!mountedRef.current) return;
            applyIncoming(msgs);
          });
        } catch {}
      });

      es.addEventListener('ping', () => {
        // keep-alive, ignore
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);
        if (mountedRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };

      es.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        // The first open is the initial subscription — history already covers
        // it. Every later open follows a drop, and only then can messages have
        // been missed.
        const reopened = hasConnectedRef.current;
        hasConnectedRef.current = true;
        if (reopened) void runCatchup();
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [topicId, isGuest, isMember, provisionArchiveAccess, ingest, applyIncoming]);

  // Root chrome: card by default, flex column when it has to fill its parent.
  const rootStyle = fullHeight
    ? framed
      ? panelFramedFullHeightStyle
      : panelFullHeightStyle
    : panelStyle;

  // Every current host (the chat rail's narrow column, the full-screen mobile
  // sheet, and the standalone /chat/[id] and /dm/[id] pages) already caps its
  // own reading width where that matters, so the panel itself no longer needs
  // a mode-specific measure.
  const measureStyle: React.CSSProperties = { width: '100%' };

  // Topic pages pass the topic name; everything else keeps the generic label.
  const headerLabel = (
    <div style={headerLeftStyle}>
      <span style={{ fontSize: roomy ? 16 : 14, flexShrink: 0 }}>💬</span>
      {title ? (
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: roomy ? 15 : 13,
            fontWeight: 700,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap' as const,
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.08em',
            color: 'var(--muted)',
            marginTop: 1,
          }}>
            Live Chat{presence.count > 0 ? ` · ${presence.count} online` : ''}
          </div>
        </div>
      ) : (
        <>
          <span style={headerTitleStyle}>Live Chat</span>
          {presence.count > 0 && <span style={onlineCountStyle}>{presence.count} online</span>}
        </>
      )}
    </div>
  );

  // ─── Guest / non-member state ──────────────────────────────────────────────
  if (isGuest || !isMember) {
    return (
      <div style={rootStyle}>
        {!hideHeader && (
          <div style={headerStyle}>
            <div style={headerLeftStyle}>
              <span style={{ fontSize: 14 }}>💬</span>
              <span style={headerTitleStyle}>Live Chat</span>
            </div>
            {onClose && <button onClick={onClose} aria-label="Close chat" style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>}
          </div>
        )}
        <div style={{
          padding: '20px 14px',
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
        }}>
          Join this topic to view chat
        </div>
      </div>
    );
  }

  // ─── Member state ─────────────────────────────────────────────────────────
  return (
    <div style={rootStyle}>
      {/* Header */}
      {!hideHeader && (
      <div style={headerStyle}>
        {headerLabel}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {presence.users.length > 0 && <PresenceDots users={presence.users} max={roomy ? 8 : 4} />}
          <div style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: connected ? '#22c55e' : '#6b7280',
            flexShrink: 0,
          }} title={connected ? 'Connected' : 'Reconnecting'} />
          {/* Per-topic notification mute (P-S). Renders nothing until known. */}
          <TopicMuteToggle topicId={topicId} enabled={!isGuest && isMember} style={{ lineHeight: 1, flexShrink: 0 }} />
          {onClose && <button onClick={onClose} aria-label="Close chat" style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>}
        </div>
      </div>
      )}

      {/* Messages — the only scroller once the panel fills its parent. */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        style={fullHeight ? {
        ...messagesContainerStyle,
        maxHeight: 'none',
        flex: 1,
        minHeight: 0,
        padding: roomy ? '16px 20px' : '10px 14px',
        overflowY: 'auto' as const,
      } : messagesContainerStyle}>
        <div style={{
          ...measureStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: roomy ? 8 : 6,
          // Short conversations sit on the composer instead of floating at the
          // top of a tall column. `margin-top: auto` (not justify-content) so a
          // long list still scrolls from the very first message.
          ...(fullHeight ? { marginTop: 'auto' } : null),
        }}>
          {/* Older history. Scrolling to the top loads the next page too; the
              button exists so a short panel (a non-fullHeight host barely
              scrolls) and keyboard users are not stuck at 50 messages. It
              disappears once the beginning of the topic is reached. */}
          {hasMoreHistory && (
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              style={{
                alignSelf: 'center',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 999,
                color: 'var(--muted)',
                cursor: loadingOlder ? 'default' : 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                padding: '3px 12px',
                marginBottom: 4,
                opacity: loadingOlder ? 0.5 : 1,
              }}
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {messages.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '20px 0' }}>
              No messages yet
            </div>
          ) : (
            messages.map((msg, i) => {
              // Same-author messages within 60s collapse into a single
              // group (matches the mobile chat). Hide the nickname row
              // and trim the gap.
              const prev = messages[i - 1];
              const grouped =
                prev != null &&
                prev.type === 'message' &&
                msg.type === 'message' &&
                prev.userId === msg.userId &&
                !!prev.isAI === !!msg.isAI &&
                new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 60_000;
              return (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  grouped={grouped}
                  roomy={roomy}
                  own={myUserId != null && msg.userId === myUserId}
                />
              );
            })
          )}
        </div>
      </div>

      {/* Composer — pinned to the bottom of the panel. */}
      <div style={{
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: roomy ? '12px 20px' : '8px 10px',
        ...measureStyle,
      }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void sendImage(file);
            // Allow selecting the same file again later.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected || uploading}
          aria-label="Attach image"
          title="Attach image"
          style={{
            background: 'rgba(120,140,255,0.08)',
            color: 'var(--muted)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: '6px 8px',
            cursor: connected && !uploading ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: connected && !uploading ? 1 : 0.5,
            flexShrink: 0,
          }}
        >
          {uploading ? (
            <span style={{ fontSize: 12 }}>…</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          )}
        </button>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            // Pasted image from clipboard → upload directly.
            const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
            const file = item?.getAsFile();
            if (file) {
              e.preventDefault();
              void sendImage(file);
            }
          }}
          placeholder="Type a message..."
          maxLength={1000}
          disabled={!connected}
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: roomy ? '9px 12px' : '7px 10px',
            color: 'var(--foreground)',
            fontSize: roomy ? 14 : 13,
            outline: 'none',
            boxSizing: 'border-box',
            opacity: connected ? 1 : 0.5,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || !connected || sending}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: roomy ? '9px 16px' : '7px 12px',
            fontSize: roomy ? 14 : 13,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
            opacity: (!inputValue.trim() || !connected || sending) ? 0.4 : 1,
            transition: 'opacity 0.12s',
          }}
        >
          {sending ? '...' : 'Send'}
        </button>
        </div>
      </div>
    </div>
  );
}
