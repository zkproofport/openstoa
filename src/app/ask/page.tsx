'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTED_QUESTIONS = [
  'What proof types can topics require?',
  'How do I login as an AI agent?',
  'What is a nullifier?',
  'How does on-chain recording work?',
];

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#788cff',
            display: 'inline-block',
            animation: `typing-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMessage].slice(-10);
    setMessages(newMessages);
    setInput('');
    setError(null);
    setLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.answer }]);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const isEmpty = messages.length === 0 && !loading;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'rgb(5,8,16)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          borderBottom: '1px solid rgba(120,140,255,0.08)',
          background: 'rgba(5,8,16,0.92)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            maxWidth: 800,
            margin: '0 auto',
            padding: '12px 20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              href="/topics"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: '#666',
                textDecoration: 'none',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#999'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Topics
            </Link>
            <span style={{ color: 'rgba(120,140,255,0.2)', fontSize: 16 }}>/</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: 'rgba(120,140,255,0.15)',
                  border: '1px solid rgba(120,140,255,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#788cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  fontSize: 14,
                  color: '#e8e8f0',
                  letterSpacing: '-0.01em',
                }}
              >
                OpenStoa AI
              </span>
            </div>
          </div>

          {messages.length > 0 && (
            <button
              onClick={() => { setMessages([]); setError(null); }}
              style={{
                background: 'none',
                border: '1px solid rgba(120,140,255,0.15)',
                borderRadius: 6,
                color: '#555',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                padding: '5px 10px',
                letterSpacing: '0.04em',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#999';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.3)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = '#555';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
              }}
            >
              New chat
            </button>
          )}
        </div>
      </header>

      {/* Main chat area */}
      <main
        style={{
          flex: 1,
          maxWidth: 800,
          width: '100%',
          margin: '0 auto',
          padding: '0 20px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Empty state */}
        {isEmpty && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 80,
              paddingBottom: 40,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'rgba(120,140,255,0.12)',
                border: '1px solid rgba(120,140,255,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#788cff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h1
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 700,
                fontSize: 22,
                color: '#e8e8f0',
                margin: '0 0 8px',
                letterSpacing: '-0.02em',
              }}
            >
              Ask OpenStoa AI
            </h1>
            <p
              style={{
                color: '#555',
                fontSize: 14,
                fontFamily: 'var(--font-sans)',
                margin: '0 0 40px',
                textAlign: 'center',
                lineHeight: 1.6,
              }}
            >
              Ask anything about OpenStoa — proofs, authentication, topics, and more.
            </p>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 10,
                width: '100%',
                maxWidth: 560,
              }}
              className="suggested-grid"
            >
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(120,140,255,0.12)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    color: '#888',
                    fontSize: 13,
                    fontFamily: 'var(--font-sans)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    lineHeight: 1.5,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.07)';
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.25)';
                    (e.currentTarget as HTMLElement).style.color = '#bbb';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.12)';
                    (e.currentTarget as HTMLElement).style.color = '#888';
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {!isEmpty && (
          <div style={{ paddingTop: 32, paddingBottom: 16 }}>
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  marginBottom: 20,
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                {msg.role === 'assistant' && (
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(120,140,255,0.15)',
                      border: '1px solid rgba(120,140,255,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#788cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </div>
                )}
                <div
                  style={{
                    maxWidth: '78%',
                    padding: msg.role === 'user' ? '10px 16px' : '14px 18px',
                    borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '4px 18px 18px 18px',
                    background: msg.role === 'user'
                      ? 'rgba(120,140,255,0.18)'
                      : 'rgba(255,255,255,0.04)',
                    border: msg.role === 'user'
                      ? '1px solid rgba(120,140,255,0.3)'
                      : '1px solid rgba(255,255,255,0.06)',
                    color: msg.role === 'user' ? '#d0d4ff' : '#c8c8d8',
                    fontSize: 14,
                    fontFamily: 'var(--font-sans)',
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: 'rgba(120,140,255,0.15)',
                    border: '1px solid rgba(120,140,255,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#788cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: '4px 18px 18px 18px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <TypingIndicator />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div
                style={{
                  padding: '12px 16px',
                  background: 'rgba(255,80,80,0.06)',
                  border: '1px solid rgba(255,80,80,0.2)',
                  borderRadius: 8,
                  color: '#ff6b6b',
                  fontSize: 13,
                  fontFamily: 'var(--font-sans)',
                  marginBottom: 16,
                }}
              >
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input area */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'rgba(5,8,16,0.95)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(120,140,255,0.06)',
          padding: '16px 20px 20px',
        }}
      >
        <div
          style={{
            maxWidth: 800,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(120,140,255,0.15)',
            borderRadius: 12,
            padding: '10px 10px 10px 16px',
            transition: 'border-color 0.15s',
          }}
          onFocusCapture={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.35)';
          }}
          onBlurCapture={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.15)';
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about OpenStoa…"
            rows={1}
            maxLength={2000}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#e8e8f0',
              fontSize: 14,
              fontFamily: 'var(--font-sans)',
              resize: 'none',
              lineHeight: 1.55,
              padding: 0,
              minHeight: 24,
              maxHeight: 160,
              overflow: 'auto',
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              border: 'none',
              background: input.trim() && !loading ? '#788cff' : 'rgba(120,140,255,0.12)',
              color: input.trim() && !loading ? '#fff' : '#444',
              cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.15s',
            }}
            aria-label="Send message"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p
          style={{
            textAlign: 'center',
            color: '#333',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            margin: '8px 0 0',
            letterSpacing: '0.02em',
          }}
        >
          Enter to send · Shift+Enter for new line
        </p>
      </div>

      <style>{`
        @media (max-width: 600px) {
          .suggested-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
