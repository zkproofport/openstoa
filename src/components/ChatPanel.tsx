'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';
import Badge from '@/components/Badge';
import LinkPreview from '@/components/LinkPreview';
import { getMlsSessionStore, getTakSessionStore } from '@/lib/mls/webTransport';
import type { Visibility } from '@/lib/mls/takSession';

// Server rows for user messages carry an encrypted `sealed` body, not plaintext.
// Decrypt for local display so MessageRow keeps rendering `msg.message` as text.
// System rows (join/leave) carry plaintext `message` and pass through unchanged.
async function toDisplayMessage(
  topicId: string,
  raw: { id?: string; type?: string; sealed?: { ciphertext: string; epoch: number } | null; message?: string },
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
  /** When set, an inline expand button appears in the header.
   *  Keeps the affordance from overlapping the PresenceDots avatars. */
  onExpand?: () => void;
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
  /** Maximized presentation: roomier type and a centered reading measure. */
  expanded?: boolean;
  /** Restore control shown in the header while maximized. */
  onCollapse?: () => void;
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

const iconButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  padding: 3,
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
  flexShrink: 0,
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
  onExpand,
  framed,
  title,
  expanded,
  onCollapse,
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
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
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch }),
      });
      // Optimistic local echo (sender can't decrypt its own MLS message).
      if (res.ok) {
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            setMessages((prev) =>
              prev.some((m) => m.id === payload.id) ? prev : [...prev, { ...payload, message: publicUrl }],
            );
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
  }, [topicId]);

  async function handleSend() {
    const text = inputValue.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const sealed = await getMlsSessionStore().seal(topicId, text);
      rememberOwnPlaintext(sealed.ciphertext, text);
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch }),
      });
      if (res.ok) {
        // Optimistic local echo: an MLS sender cannot decrypt its own sealed
        // message (the sender ratchet has advanced), so show the known
        // plaintext directly. The SSE echo carries the same id and dedupes.
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            setMessages((prev) =>
              prev.some((m) => m.id === payload.id) ? prev : [...prev, { ...payload, message: text }],
            );
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

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
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

      const data = await fetch(`/api/topics/${topicId}/chat?limit=50`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!mountedRef.current || !data?.messages) return;
      const decrypted = await Promise.all(
        data.messages.map((m: Parameters<typeof toDisplayMessage>[1]) =>
          toDisplayMessage(topicId, m, pendingSendsRef.current),
        ),
      );
      if (!mountedRef.current) return;
      setMessages(decrypted.reverse());

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
          // Decrypt the sealed body before display (async; dedupe on arrival).
          toDisplayMessage(topicId, raw, pendingSendsRef.current).then((msg) => {
            if (!mountedRef.current) return;
            setMessages((prev) => {
              if (prev.some((m) => m.id === msg.id)) return prev;
              return [...prev, msg];
            });
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
        if (mountedRef.current) setConnected(true);
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
  }, [topicId, isGuest, isMember, provisionArchiveAccess]);

  // Root chrome: card by default, flex column when it has to fill its parent.
  const rootStyle = fullHeight
    ? framed
      ? panelFramedFullHeightStyle
      : panelFullHeightStyle
    : panelStyle;

  // Maximized view keeps a comfortable reading measure — lines should not run
  // the full width of a 1100px dialog.
  const measureStyle: React.CSSProperties = expanded
    ? { width: '100%', maxWidth: 860, margin: '0 auto' }
    : { width: '100%' };

  // Topic pages pass the topic name; everything else keeps the generic label.
  const headerLabel = (
    <div style={headerLeftStyle}>
      <span style={{ fontSize: expanded ? 16 : 14, flexShrink: 0 }}>💬</span>
      {title ? (
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: expanded ? 15 : 13,
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
          {presence.users.length > 0 && <PresenceDots users={presence.users} max={expanded ? 8 : 4} />}
          <div style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: connected ? '#22c55e' : '#6b7280',
            flexShrink: 0,
          }} title={connected ? 'Connected' : 'Reconnecting'} />
          {onExpand && !expanded && (
            <button
              type="button"
              onClick={onExpand}
              className="chat-expand-btn"
              aria-label="Maximize chat"
              aria-expanded={false}
              title="Maximize chat"
              style={iconButtonStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          {onCollapse && expanded && (
            <button
              type="button"
              onClick={onCollapse}
              className="chat-collapse-btn"
              aria-label="Restore chat to sidebar"
              aria-expanded={true}
              title="Restore chat (Esc)"
              style={iconButtonStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          {onClose && <button onClick={onClose} aria-label="Close chat" style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>}
        </div>
      </div>
      )}

      {/* Messages — the only scroller once the panel fills its parent. */}
      <div style={fullHeight ? {
        ...messagesContainerStyle,
        maxHeight: 'none',
        flex: 1,
        minHeight: 0,
        padding: expanded ? '16px 20px' : '10px 14px',
        overflowY: 'auto' as const,
      } : messagesContainerStyle}>
        <div style={{
          ...measureStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: expanded ? 8 : 6,
          // Short conversations sit on the composer instead of floating at the
          // top of a tall column. `margin-top: auto` (not justify-content) so a
          // long list still scrolls from the very first message.
          ...(fullHeight ? { marginTop: 'auto' } : null),
        }}>
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
                  roomy={expanded}
                  own={myUserId != null && msg.userId === myUserId}
                />
              );
            })
          )}
          <div ref={messagesEndRef} />
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
        padding: expanded ? '12px 20px' : '8px 10px',
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
            padding: expanded ? '9px 12px' : '7px 10px',
            color: 'var(--foreground)',
            fontSize: expanded ? 14 : 13,
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
            padding: expanded ? '9px 16px' : '7px 12px',
            fontSize: expanded ? 14 : 13,
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
