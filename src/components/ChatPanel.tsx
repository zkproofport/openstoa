'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';
import Badge from '@/components/Badge';
import LinkPreview from '@/components/LinkPreview';

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
function renderLinkedText(text: string): React.ReactNode {
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
        style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
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
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
};

const headerLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
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

function PresenceDots({ users }: { users: PresenceUser[] }) {
  const shown = users.slice(0, 5);
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
      {users.length > 5 && (
        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>
          +{users.length - 5}
        </span>
      )}
    </div>
  );
}

// ─── Message row ──────────────────────────────────────────────────────────────

function MessageRow({ msg, grouped }: { msg: ChatMessage; grouped?: boolean }) {
  if (msg.type === 'join' || msg.type === 'leave') {
    return (
      <div style={{
        fontSize: 11,
        color: 'var(--muted)',
        fontStyle: 'italic',
        padding: '1px 0',
        lineHeight: 1.4,
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

  return (
    <div style={{ lineHeight: 1.4, marginTop: grouped ? -2 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        {!grouped && (
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--accent)',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}>
            {msg.nickname}
            {msg.isAI && <Badge type="ai" />}
          </span>
        )}
        {!hideMessageText && (
          <span style={{
            fontSize: 13,
            color: 'var(--foreground)',
            wordBreak: 'break-word' as const,
            flex: 1,
            minWidth: 0,
          }}>
            {renderLinkedText(msg.message)}
          </span>
        )}
      </div>
      {inlineImage && (
        <a
          href={inlineImage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'block', marginTop: 4 }}
        >
          <img
            src={inlineImage}
            alt=""
            style={{
              maxWidth: '100%',
              maxHeight: 240,
              borderRadius: 8,
              border: '1px solid var(--border)',
              display: 'block',
            }}
          />
        </a>
      )}
      {firstUrl && !inlineImage && (
        <div style={{ marginTop: 6, marginBottom: 2 }}>
          <LinkPreview url={firstUrl} />
        </div>
      )}
      {!grouped && (
        <div style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          marginTop: 1,
          textAlign: 'right' as const,
        }}>
          {relativeTime(msg.createdAt)}
        </div>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChatPanel({ topicId, isGuest, isMember, fullHeight, hideHeader, onClose, onExpand }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<{ users: PresenceUser[]; count: number }>({ users: [], count: 0 });
  const [connected, setConnected] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

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
      await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: publicUrl }),
      });
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
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (res.ok) {
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

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isGuest || !isMember) return;

    mountedRef.current = true;

    // Fetch history
    fetch(`/api/topics/${topicId}/chat?limit=50`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!mountedRef.current) return;
        if (data?.messages) {
          // History comes in DESC order (newest first), reverse for chronological display
          setMessages([...data.messages].reverse());
        }
      })
      .catch(() => {});

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
          const msg: ChatMessage = JSON.parse(e.data);
          setMessages((prev) => {
            // Deduplicate by id
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
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
  }, [topicId, isGuest, isMember]);

  // ─── Guest / non-member state ──────────────────────────────────────────────
  if (isGuest || !isMember) {
    return (
      <div style={fullHeight ? panelFullHeightStyle : panelStyle}>
        {!hideHeader && (
          <div style={headerStyle}>
            <div style={headerLeftStyle}>
              <span style={{ fontSize: 14 }}>💬</span>
              <span style={headerTitleStyle}>Live Chat</span>
            </div>
            {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>}
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
    <div style={fullHeight ? panelFullHeightStyle : panelStyle}>
      {/* Header */}
      {!hideHeader && (
      <div style={headerStyle}>
        <div style={headerLeftStyle}>
          <span style={{ fontSize: 14 }}>💬</span>
          <span style={headerTitleStyle}>Live Chat</span>
          {presence.count > 0 && (
            <span style={onlineCountStyle}>{presence.count} online</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              className="chat-expand-btn"
              aria-label="Expand chat"
              title="Expand chat"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: 2,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
          {presence.users.length > 0 && <PresenceDots users={presence.users} />}
          <div style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: connected ? '#22c55e' : '#6b7280',
            flexShrink: 0,
          }} />
          {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>×</button>}
        </div>
      </div>
      )}

      {/* Messages */}
      <div style={fullHeight ? {
        ...messagesContainerStyle,
        maxHeight: 'none',
        flex: 1,
        overflowY: 'auto' as const,
      } : messagesContainerStyle}>
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
            return <MessageRow key={msg.id} msg={msg} grouped={grouped} />;
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderTop: '1px solid var(--border)',
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
            padding: '7px 10px',
            color: 'var(--foreground)',
            fontSize: 13,
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
            padding: '7px 12px',
            fontSize: 13,
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
  );
}
