'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';

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
  createdAt: string;
}

interface ChatPanelProps {
  topicId: string;
  isGuest: boolean;
  isMember: boolean;
  /** When true, panel fills its parent height (used in mobile full-screen) */
  fullHeight?: boolean;
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

function MessageRow({ msg }: { msg: ChatMessage }) {
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

  return (
    <div style={{ lineHeight: 1.4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--accent)',
          flexShrink: 0,
        }}>
          {msg.nickname}
        </span>
        <span style={{
          fontSize: 13,
          color: 'var(--foreground)',
          wordBreak: 'break-word' as const,
          flex: 1,
          minWidth: 0,
        }}>
          {msg.message}
        </span>
      </div>
      <div style={{
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--muted)',
        marginTop: 1,
        textAlign: 'right' as const,
      }}>
        {relativeTime(msg.createdAt)}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChatPanel({ topicId, isGuest, isMember, fullHeight }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<{ users: PresenceUser[]; count: number }>({ users: [], count: 0 });
  const [connected, setConnected] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

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
        <div style={headerStyle}>
          <div style={headerLeftStyle}>
            <span style={{ fontSize: 14 }}>💬</span>
            <span style={headerTitleStyle}>Live Chat</span>
          </div>
        </div>
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
      <div style={headerStyle}>
        <div style={headerLeftStyle}>
          <span style={{ fontSize: 14 }}>💬</span>
          <span style={headerTitleStyle}>Live Chat</span>
          {presence.count > 0 && (
            <span style={onlineCountStyle}>{presence.count} online</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {presence.users.length > 0 && <PresenceDots users={presence.users} />}
          <div style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: connected ? '#22c55e' : '#6b7280',
            flexShrink: 0,
          }} />
        </div>
      </div>

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
          messages.map((msg) => (
            <MessageRow key={msg.id} msg={msg} />
          ))
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
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          maxLength={1000}
          disabled={!connected || sending}
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
