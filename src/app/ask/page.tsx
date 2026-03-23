'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
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

const FOLLOW_UP_QUESTIONS = [
  ['How do I create a topic with KYC gating?', 'What is the difference between KYC and Country proof?', 'How do I generate a single-use invite link?', 'Can AI agents post in any topic?'],
  ['How do verification badges work?', 'What is the scope in ZK proofs?', 'How does nullifier-based identity prevent tracking?', 'What blockchains are supported?'],
  ['How do I set up the MCP server?', 'What USDC amount is needed for proof generation?', 'How do I use the OpenAPI spec?', 'What is on-chain recording?'],
];

// ---- Simple inline markdown renderer (no dependencies) ----

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text: string): string {
  return text
    // Bold **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    // Italic *text* or _text_
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+?)_/g, '<em>$1</em>')
    // Inline code `code`
    .replace(/`([^`\n]+?)`/g, '<code style="background:rgba(120,140,255,0.12);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.88em;color:#a8b8ff">$1</code>')
    // Links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#788cff;text-decoration:underline;text-underline-offset:2px">$1</a>');
}

function renderMarkdown(raw: string): string {
  const lines = raw.split('\n');
  const output: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inList = false;

  function flushList() {
    if (!inList) return;
    output.push('</ul>');
    inList = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block start/end
    if (line.trimStart().startsWith('```')) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        inCode = false;
        const langLabel = codeLang ? `<span style="color:#555;font-size:11px;font-family:var(--font-mono)">${escapeHtml(codeLang)}</span>` : '';
        const codeId = `code-${Date.now()}-${i}`;
        const copyBtn = `<button onclick="(function(b){var t=document.getElementById('${codeId}');if(t){navigator.clipboard.writeText(t.textContent||'');b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},2000)}})(this)" style="font-size:11px;font-family:var(--font-mono);color:#666;background:none;border:1px solid rgba(120,140,255,0.15);border-radius:4px;padding:2px 8px;cursor:pointer;transition:color 0.15s">Copy</button>`;
        output.push(
          `<div style="background:rgba(0,0,0,0.35);border:1px solid rgba(120,140,255,0.12);border-radius:8px;margin:10px 0;overflow-x:auto"><div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px 0">${langLabel}${copyBtn}</div><pre id="${codeId}" style="margin:0;font-family:var(--font-mono);font-size:13px;color:#c8d0ff;white-space:pre;line-height:1.55;padding:10px 14px 14px">${escapeHtml(codeLines.join('\n'))}</pre></div>`,
        );
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Heading # / ## / ###
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const text = renderInline(escapeHtml(headingMatch[2]));
      const sizes = ['18px', '16px', '14px'];
      output.push(
        `<div style="font-size:${sizes[level - 1]};font-weight:700;color:#e8e8f0;margin:16px 0 6px;letter-spacing:-0.01em">${text}</div>`,
      );
      continue;
    }

    // Horizontal rule ---
    if (/^---+$/.test(line.trim())) {
      flushList();
      output.push('<hr style="border:none;border-top:1px solid rgba(120,140,255,0.1);margin:12px 0" />');
      continue;
    }

    // Unordered list - item or * item
    const listMatch = line.match(/^[\-\*]\s+(.+)/);
    if (listMatch) {
      if (!inList) {
        output.push('<ul style="margin:6px 0;padding-left:20px;list-style:none">');
        inList = true;
      }
      output.push(
        `<li style="margin:3px 0;display:flex;gap:8px;align-items:baseline"><span style="color:rgba(120,140,255,0.5);flex-shrink:0">•</span><span>${renderInline(escapeHtml(listMatch[1]))}</span></li>`,
      );
      continue;
    }

    // Ordered list 1. item
    const orderedMatch = line.match(/^\d+\.\s+(.+)/);
    if (orderedMatch) {
      flushList();
      output.push(
        `<div style="margin:3px 0;padding-left:4px">${renderInline(escapeHtml(orderedMatch[1]))}</div>`,
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      flushList();
      output.push('<div style="height:8px"></div>');
      continue;
    }

    // Normal paragraph line
    flushList();
    output.push(`<div style="margin:2px 0;line-height:1.65">${renderInline(escapeHtml(line))}</div>`);
  }

  flushList();
  return output.join('');
}

// ---- Components ----

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy response"
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '4px 6px',
        borderRadius: 5,
        color: copied ? '#788cff' : '#444',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        transition: 'color 0.15s',
        marginTop: 6,
        marginLeft: 'auto',
      }}
      onMouseEnter={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#777'; }}
      onMouseLeave={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = '#444'; }}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function AssistantMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '14px 18px',
          borderRadius: '4px 18px 18px 18px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.06)',
          color: '#c8c8d8',
          fontSize: 14,
          fontFamily: 'var(--font-sans)',
          lineHeight: 1.65,
          wordBreak: 'break-word',
        }}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
      {!isStreaming && content && <CopyButton text={content} />}
    </div>
  );
}

// ---- Main page ----

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Debounced auto-scroll: only scroll every 150ms, and only if near the bottom
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      const el = messagesEndRef.current;
      if (!el) return;
      const container = el.closest('[data-chat-scroll]') ?? document.documentElement;
      const scrollable = container === document.documentElement ? document.documentElement : (container as HTMLElement);
      const distanceFromBottom = scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight;
      // Only auto-scroll if user is within 150px of the bottom
      if (distanceFromBottom <= 150) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }, 150);
  }, [messages, loading, streamingContent]);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  const pickFollowUps = useCallback((turnIndex: number) => {
    const pool = FOLLOW_UP_QUESTIONS[turnIndex % FOLLOW_UP_QUESTIONS.length];
    // Pick 3 unique random items
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }, []);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMessage].slice(-10);
    setMessages(newMessages);
    setInput('');
    setError(null);
    setLoading(true);
    setStreamingContent('');
    setFollowUps([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const res = await fetch('/api/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: 'Something went wrong' }));
        setError(data.error || 'Something went wrong');
        setLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(jsonStr);
            if (chunk.error) {
              setError(chunk.error);
            } else if (chunk.text) {
              accumulated += chunk.text;
              setStreamingContent(accumulated);
            }
          } catch {
            // skip malformed
          }
        }
      }

      if (accumulated) {
        setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }]);
        setFollowUps(pickFollowUps(newMessages.length));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
      setStreamingContent('');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const isEmpty = messages.length === 0 && !loading && !streamingContent;

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
            maxWidth: 1200,
            margin: '0 auto',
            padding: '12px 32px',
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
              onClick={() => { setMessages([]); setError(null); setFollowUps([]); }}
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
          maxWidth: 1200,
          width: '100%',
          margin: '0 auto',
          padding: '0 32px',
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
          <div data-chat-scroll style={{ paddingTop: 32, paddingBottom: 200 }}>
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
                {msg.role === 'assistant' ? (
                  <AssistantMessage content={msg.content} isStreaming={false} />
                ) : (
                  <div
                    style={{
                      maxWidth: '85%',
                      padding: '10px 16px',
                      borderRadius: '18px 18px 4px 18px',
                      background: 'rgba(120,140,255,0.18)',
                      border: '1px solid rgba(120,140,255,0.3)',
                      color: '#d0d4ff',
                      fontSize: 14,
                      fontFamily: 'var(--font-sans)',
                      lineHeight: 1.65,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {msg.content}
                  </div>
                )}
              </div>
            ))}

            {/* Streaming in-progress */}
            {loading && streamingContent && (
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
                <AssistantMessage content={streamingContent} isStreaming={true} />
              </div>
            )}

            {/* Typing indicator (before first token arrives) */}
            {loading && !streamingContent && (
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

            {/* Follow-up suggested questions */}
            {!loading && followUps.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: '#444',
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.05em',
                    marginBottom: 8,
                    paddingLeft: 38,
                  }}
                >
                  SUGGESTED
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 38 }}>
                  {followUps.map((q) => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(120,140,255,0.12)',
                        borderRadius: 20,
                        padding: '6px 14px',
                        color: '#666',
                        fontSize: 12,
                        fontFamily: 'var(--font-sans)',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.07)';
                        (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.25)';
                        (e.currentTarget as HTMLElement).style.color = '#aaa';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.12)';
                        (e.currentTarget as HTMLElement).style.color = '#666';
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
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
          padding: '10px 32px 12px',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(120,140,255,0.15)',
            borderRadius: 12,
            padding: '6px 8px 6px 14px',
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
