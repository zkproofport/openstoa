'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+?)_/g, '<em>$1</em>')
    .replace(/`([^`\n]+?)`/g, '<code style="background:var(--color-brand-primary-muted);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:0.88em;color:var(--color-brand-primary)">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--color-brand-primary);text-decoration:underline;text-underline-offset:2px">$1</a>');
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

    if (line.trimStart().startsWith('```')) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = line.slice(line.indexOf('```') + 3).trim();
        codeLines = [];
      } else {
        inCode = false;
        const langLabel = codeLang ? `<span style="color:var(--color-text-tertiary);font-size:11px;font-family:var(--font-mono)">${escapeHtml(codeLang)}</span>` : '';
        const codeId = `code-${Date.now()}-${i}`;
        const copyBtn = `<button onclick="(function(b){var t=document.getElementById('${codeId}');if(t){navigator.clipboard.writeText(t.textContent||'');b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},2000)}})(this)" style="font-size:11px;font-family:var(--font-mono);color:var(--color-text-tertiary);background:none;border:1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent);border-radius:4px;padding:2px 8px;cursor:pointer;transition:color 0.15s">Copy</button>`;
        output.push(
          `<div style="background:var(--color-bg-primary);border:1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent);border-radius:8px;margin:10px 0;overflow-x:auto"><div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px 0">${langLabel}${copyBtn}</div><pre id="${codeId}" style="margin:0;font-family:var(--font-mono);font-size:12px;color:var(--color-brand-primary);white-space:pre-wrap;overflow-wrap:break-word;line-height:1.55;padding:8px 12px 12px">${escapeHtml(codeLines.join('\n'))}</pre></div>`,
        );
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) { codeLines.push(line); continue; }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const text = renderInline(escapeHtml(headingMatch[2]));
      const sizes = ['18px', '16px', '14px'];
      output.push(`<div style="font-size:${sizes[level - 1]};font-weight:700;color:var(--color-text-primary);margin:16px 0 6px;letter-spacing:-0.01em">${text}</div>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushList();
      output.push('<hr style="border:none;border-top:1px solid color-mix(in srgb, var(--color-brand-primary) 10%, transparent);margin:12px 0" />');
      continue;
    }

    const listMatch = line.match(/^[\-\*]\s+(.+)/);
    if (listMatch) {
      if (!inList) { output.push('<ul style="margin:6px 0;padding-left:20px;list-style:none">'); inList = true; }
      output.push(`<li style="margin:3px 0;display:flex;gap:8px;align-items:baseline"><span style="color:color-mix(in srgb, var(--color-brand-primary) 50%, transparent);flex-shrink:0">•</span><span>${renderInline(escapeHtml(listMatch[1]))}</span></li>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)/);
    if (orderedMatch) {
      flushList();
      output.push(`<div style="margin:3px 0;padding-left:4px">${renderInline(escapeHtml(orderedMatch[1]))}</div>`);
      continue;
    }

    if (line.trim() === '') { flushList(); output.push('<div style="height:8px"></div>'); continue; }

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
            width: 6, height: 6, borderRadius: '50%', background: 'var(--color-brand-primary)',
            display: 'inline-block',
            animation: `typing-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`@keyframes typing-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-6px); opacity: 1; } }`}</style>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} }}
      title="Copy response"
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '4px 6px', borderRadius: 5,
        color: copied ? 'var(--color-brand-primary)' : 'var(--color-border-strong)',
        fontSize: 11, fontFamily: 'var(--font-mono)',
        display: 'flex', alignItems: 'center', gap: 4,
        transition: 'color 0.15s',
      }}
      onMouseEnter={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
      onMouseLeave={(e) => { if (!copied) (e.currentTarget as HTMLElement).style.color = 'var(--color-border-strong)'; }}
    >
      {copied ? (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>Copied!</>
      ) : (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>Copy</>
      )}
    </button>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', padding: '14px 18px',
      borderRadius: '4px 18px 18px 18px',
      background: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border-default)',
      color: 'var(--color-text-secondary)', fontSize: 14,
      fontFamily: 'var(--font-sans)', lineHeight: 1.65,
      wordBreak: 'break-word',
    }}>
      {children}
    </div>
  );
}

function AiAvatar() {
  return (
    <div style={{
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--color-brand-primary-muted)', border: '1px solid var(--color-brand-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, marginTop: 2,
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </div>
  );
}

// ---- Main page ----

const CONTENT_WIDTH = 640;

export default function AskPage() {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll: debounce with clear+restart
  const userScrolledUpRef = useRef(false);

  // Track if user manually scrolled up
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    function onScroll() {
      const dist = container!.scrollHeight - container!.scrollTop - container!.clientHeight;
      userScrolledUpRef.current = dist > 400;
    }
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (userScrolledUpRef.current) return; // respect user scroll
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      const container = scrollContainerRef.current;
      if (!container || userScrolledUpRef.current) return;
      container.scrollTo({ top: container.scrollHeight, behavior: streamingContent ? 'auto' : 'smooth' });
    }, 60);
  }, [messages, loading, streamingContent]);

  // Reset scroll lock when new message is sent
  useEffect(() => {
    if (loading) userScrolledUpRef.current = false;
  }, [loading]);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  const pickFollowUps = useCallback((turnIndex: number) => {
    const pool = FOLLOW_UP_QUESTIONS[turnIndex % FOLLOW_UP_QUESTIONS.length];
    return [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
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
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      const res = await apiFetch('/api/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
        /*
         * NO DEADLINE, deliberately. This response is read incrementally with
         * `body.getReader()` below and a long answer legitimately takes minutes
         * to finish arriving — a 15s cap would abort the model mid-sentence,
         * every time, which is the exact failure the default is there to
         * prevent for everything else. The stream is not unbounded either way:
         * the route ends it, and leaving the page aborts the read.
         */
        timeoutMs: null,
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
            if (chunk.error) setError(chunk.error);
            else if (chunk.text) { accumulated += chunk.text; setStreamingContent(accumulated); }
          } catch {}
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  const isEmpty = messages.length === 0 && !loading && !streamingContent;

  // DISABLED 2026-05-25: LLM API providers (OpenAI/Gemini/Anthropic) deprecated.
  // Original /ask UI is preserved below for future re-enable (remove the early return below).
  // See docs/migration/third-party-services.md §4-6.
  // NOTE (tokens/i18n migration): everything below this early return is dead
  // code while the feature is disabled -- it is intentionally left as-is
  // (not token/i18n migrated) since it is unreachable and the effort is
  // better spent on live surfaces. Migrate it alongside the re-enable work.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _suppressUnused = { isEmpty };
  if (true) {
    return (
      <main style={{ height: '100vh', background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-4)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-sans)', textAlign: 'center', padding: 'var(--space-5)' }}>
        <h1 style={{ color: 'var(--color-text-primary)', fontSize: 'var(--text-heading-sm)', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>{t('askPage.title')}</h1>
        <p style={{ margin: 0, maxWidth: 360, lineHeight: 1.6 }}>{t('askPage.unavailable')}</p>
        <Link href="/" className="os-label" style={{ color: 'var(--color-brand-primary)', textDecoration: 'none', padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-control)', border: '1px solid var(--color-brand-primary)' }}>← {t('askPage.backToHome')}</Link>
      </main>
    );
  }

  return (
    <div style={{ height: '100vh', background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ── Header ── */}
      <header style={{
        flexShrink: 0, borderBottom: '1px solid color-mix(in srgb, var(--color-brand-primary) 8%, transparent)',
        background: 'color-mix(in srgb, var(--color-bg-primary) 92%, transparent)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: CONTENT_WIDTH, margin: '0 auto', padding: '12px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link href="/topics" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-tertiary)', textDecoration: 'none', fontSize: 13, fontFamily: 'var(--font-mono)', transition: 'color 0.15s' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
              Topics
            </Link>
            <span style={{ color: 'var(--color-brand-primary-muted)', fontSize: 16 }}>/</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AiAvatar />
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>OpenStoa AI</span>
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setError(null); setFollowUps([]); }}
              style={{ background: 'none', border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)', borderRadius: 6, color: 'var(--color-text-tertiary)', fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer', padding: '5px 10px', letterSpacing: '0.04em', transition: 'all 0.15s' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--color-brand-primary) 15%, transparent)'; }}
            >New chat</button>
          )}
        </div>
      </header>

      {/* ── Scrollable messages area ── */}
      <div ref={scrollContainerRef} style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: CONTENT_WIDTH, margin: '0 auto', padding: '0 20px' }}>

          {/* Empty state */}
          {isEmpty && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, paddingBottom: 40 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--color-brand-primary-muted)', border: '1px solid var(--color-brand-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              </div>
              <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 22, color: 'var(--color-text-primary)', margin: '0 0 8px', letterSpacing: '-0.02em' }}>Ask OpenStoa AI</h1>
              <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, fontFamily: 'var(--font-sans)', margin: '0 0 40px', textAlign: 'center', lineHeight: 1.6 }}>
                Ask anything about OpenStoa — proofs, authentication, topics, and more.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, width: '100%', maxWidth: 520 }} className="suggested-grid">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button key={q} onClick={() => sendMessage(q)}
                    style={{ background: 'var(--color-bg-secondary)', border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)', borderRadius: 10, padding: '14px 16px', color: 'var(--color-text-secondary)', fontSize: 13, fontFamily: 'var(--font-sans)', textAlign: 'left', cursor: 'pointer', lineHeight: 1.5, transition: 'all 0.15s' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-brand-primary) 7%, transparent)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-secondary)'; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--color-brand-primary) 12%, transparent)'; (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)'; }}
                  >{q}</button>
                ))}
              </div>
            </div>
          )}

          {/* Message list */}
          {!isEmpty && (
            <div style={{ paddingTop: 24, paddingBottom: 16 }}>
              {messages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 20 }}>
                  {msg.role === 'assistant' ? (
                    <AssistantBubble>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <AiAvatar />
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>OpenStoa AI</span>
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-border-default)' }}>
                        <CopyButton text={msg.content} />
                      </div>
                    </AssistantBubble>
                  ) : (
                    <div style={{ maxWidth: '85%', padding: '10px 16px', borderRadius: '18px 18px 4px 18px', background: 'var(--color-brand-primary-muted)', border: '1px solid var(--color-brand-primary)', color: 'var(--color-brand-primary)', fontSize: 14, fontFamily: 'var(--font-sans)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming */}
              {loading && streamingContent && (
                <div style={{ marginBottom: 20 }}>
                  <AssistantBubble>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <AiAvatar />
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>OpenStoa AI</span>
                    </div>
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }} />
                  </AssistantBubble>
                </div>
              )}

              {/* Typing indicator */}
              {loading && !streamingContent && (
                <div style={{ marginBottom: 20 }}>
                  <AssistantBubble>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AiAvatar />
                      <TypingIndicator />
                    </div>
                  </AssistantBubble>
                </div>
              )}

              {/* Error */}
              {error && (
                <div style={{ padding: '12px 16px', background: 'color-mix(in srgb, var(--color-status-danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--color-status-danger) 20%, transparent)', borderRadius: 8, color: 'var(--color-status-danger)', fontSize: 13, fontFamily: 'var(--font-sans)', marginBottom: 16 }}>
                  {error}
                </div>
              )}

              {/* Follow-up suggestions */}
              {!loading && followUps.length > 0 && (
                <div style={{ marginBottom: 16, paddingLeft: 38 }}>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', marginBottom: 8 }}>SUGGESTED</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {followUps.map((q) => (
                      <button key={q} onClick={() => sendMessage(q)}
                        style={{ background: 'var(--color-bg-secondary)', border: '1px solid color-mix(in srgb, var(--color-brand-primary) 12%, transparent)', borderRadius: 20, padding: '6px 14px', color: 'var(--color-text-tertiary)', fontSize: 12, fontFamily: 'var(--font-sans)', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-brand-primary) 7%, transparent)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-secondary)'; (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--color-brand-primary) 12%, transparent)'; (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
                      >{q}</button>
                    ))}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* ── Input area (natural flex bottom — NOT fixed/sticky) ── */}
      <div style={{ flexShrink: 0, borderTop: '1px solid color-mix(in srgb, var(--color-brand-primary) 6%, transparent)', background: 'var(--color-bg-primary)' }}>
        <div style={{ maxWidth: CONTENT_WIDTH, margin: '0 auto', padding: '8px 20px 10px' }}>
          <div
            style={{ display: 'flex', alignItems: 'flex-end', gap: 10, background: 'var(--color-bg-secondary)', border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)', borderRadius: 10, padding: '8px 10px 8px 16px', transition: 'border-color 0.15s' }}
            onFocusCapture={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; }}
            onBlurCapture={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'color-mix(in srgb, var(--color-brand-primary) 15%, transparent)'; }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(); }}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about OpenStoa…"
              rows={1}
              maxLength={2000}
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--color-text-primary)', fontSize: 14, fontFamily: 'var(--font-sans)', resize: 'none', lineHeight: 1.55, padding: 0, minHeight: 22, maxHeight: 120, overflow: 'auto' }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
              style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: input.trim() && !loading ? 'var(--color-brand-primary)' : 'var(--color-brand-primary-muted)', color: input.trim() && !loading ? 'var(--color-text-inverted)' : 'var(--color-border-strong)', cursor: input.trim() && !loading ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s' }}
              aria-label="Send message"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
            </button>
          </div>
          <p style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 11, fontFamily: 'var(--font-mono)', margin: '4px 0 0', letterSpacing: '0.02em' }}>
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>

      <style>{`@media (max-width: 600px) { .suggested-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
