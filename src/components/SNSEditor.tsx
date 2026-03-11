'use client';

import { useCallback, useRef, useState, useEffect } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSEditorProps {
  onChange?: (html: string, media: { embeds: Embed[] }) => void;
  placeholder?: string;
  minHeight?: number;
  draftKey?: string;
}

// ─── Video URL Detection ────────────────────────────────────────────────────

function parseVideoUrl(url: string): Embed | null {
  const trimmed = url.trim();

  const ytLong = trimmed.match(/(?:youtube\.com\/watch\?.*v=)([\w-]{11})/);
  if (ytLong) return { type: 'youtube', url: trimmed, videoId: ytLong[1] };

  const ytShort = trimmed.match(/(?:youtu\.be\/)([\w-]{11})/);
  if (ytShort) return { type: 'youtube', url: trimmed, videoId: ytShort[1] };

  const ytShorts = trimmed.match(/(?:youtube\.com\/shorts\/)([\w-]{11})/);
  if (ytShorts) return { type: 'youtube', url: trimmed, videoId: ytShorts[1] };

  const vimeo = trimmed.match(/(?:vimeo\.com\/)(\d+)/);
  if (vimeo) return { type: 'vimeo', url: trimmed, videoId: vimeo[1] };

  return null;
}

// ─── SVG Icons ──────────────────────────────────────────────────────────────

const IconImage = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
    <path d="M14 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM2 4h12v5.5l-2.5-2.5-3 3-2-2L2 11.5V4zm0 8v-.5l4.5-4 2 2 3-3 2.5 2.5V12H2z"/>
    <circle cx="5" cy="6.5" r="1"/>
  </svg>
);

const IconVideo = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5l3 2V4.5l-3 2V4a1 1 0 0 0-1-1H2zm0 1h8v8H2V4z"/>
    <path d="M5.5 6v4l3.5-2-3.5-2z"/>
  </svg>
);

const IconClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <path d="M9.35 3.35a.5.5 0 0 0-.7-.7L6 5.29 3.35 2.65a.5.5 0 1 0-.7.7L5.29 6 2.65 8.65a.5.5 0 1 0 .7.7L6 6.71l2.65 2.64a.5.5 0 0 0 .7-.7L6.71 6l2.64-2.65z"/>
  </svg>
);

// ─── Upload Indicator ───────────────────────────────────────────────────────

function UploadIndicator({ count, total }: { count: number; total: number }) {
  if (total === 0) return null;
  return (
    <div style={{
      position: 'absolute',
      bottom: 60,
      right: 12,
      background: 'rgba(17,17,17,0.95)',
      border: '1px solid rgba(59,130,246,0.4)',
      color: '#93c5fd',
      fontSize: 12,
      padding: '6px 12px',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      pointerEvents: 'none',
      zIndex: 20,
    }}>
      <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 0.8s linear infinite' }}>
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
      </svg>
      Uploading {count}/{total}...
    </div>
  );
}

// ─── Draft Logic ────────────────────────────────────────────────────────────

interface DraftData {
  html: string;
  embeds: Embed[];
  savedAt: number;
}

function useDraftSave(draftKey: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  const saveDraft = useCallback((html: string, embeds: Embed[]) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaved(false);
    timerRef.current = setTimeout(() => {
      try {
        const stripped = html.replace(/<[^>]*>/g, '').trim();
        if (stripped || embeds.length > 0) {
          localStorage.setItem(draftKey, JSON.stringify({ html, embeds, savedAt: Date.now() }));
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } else {
          localStorage.removeItem(draftKey);
        }
      } catch {}
    }, 1200);
  }, [draftKey]);

  const loadDraft = useCallback((): DraftData | null => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      const data = JSON.parse(raw) as DraftData;
      const age = Date.now() - data.savedAt;
      if (age > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(draftKey);
        return null;
      }
      return data;
    } catch { return null; }
  }, [draftKey]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(draftKey); } catch {}
  }, [draftKey]);

  return { saved, saveDraft, loadDraft, clearDraft };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get the text-only character count from HTML */
function htmlTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').length;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSEditor({
  onChange,
  placeholder = '내용을 입력하세요…',
  minHeight = 180,
  draftKey = 'zk-community-draft',
}: SNSEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [embeds, setEmbeds] = useState<Embed[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState('');
  const [isEmpty, setIsEmpty] = useState(true);
  const [charCount, setCharCount] = useState(0);

  const { saved, saveDraft, loadDraft } = useDraftSave(draftKey);

  // Fire onChange
  const emitChange = useCallback((html: string, embs: Embed[]) => {
    onChange?.(html, { embeds: embs });
  }, [onChange]);

  // Check if editor is empty
  const checkEmpty = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.textContent?.trim() ?? '';
    const hasImages = el.querySelectorAll('img').length > 0;
    setIsEmpty(!text && !hasImages);
  }, []);

  // Load draft on mount
  const didLoadDraft = useRef(false);
  useEffect(() => {
    if (didLoadDraft.current) return;
    didLoadDraft.current = true;
    const draft = loadDraft();
    if (draft && editorRef.current) {
      editorRef.current.innerHTML = draft.html;
      setEmbeds(draft.embeds ?? []);
      setCharCount(htmlTextLength(draft.html));
      emitChange(draft.html, draft.embeds ?? []);
      checkEmpty();
    }
  }, [loadDraft, emitChange, checkEmpty]);

  // Handle editor input
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = el.innerHTML;
    checkEmpty();
    setCharCount(htmlTextLength(html));
    emitChange(html, embeds);
    saveDraft(html, embeds);
  }, [embeds, checkEmpty, emitChange, saveDraft]);

  // ─── Image Upload ───────────────────────────────────────────────────────

  const uploadFile = useCallback(async (file: File): Promise<string | null> => {
    if (!file.type.startsWith('image/')) return null;
    if (file.size > 10 * 1024 * 1024) return null;

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      if (!res.ok) throw new Error('Upload request failed');

      const { uploadUrl, publicUrl } = await res.json();
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error('R2 upload failed');
      return publicUrl;
    } catch (err) {
      console.error('Image upload failed:', err);
      return null;
    }
  }, []);

  const insertImageAtCursor = useCallback((url: string) => {
    const el = editorRef.current;
    if (!el) return;

    el.focus();
    const sel = window.getSelection();
    const createImg = () => {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.style.borderRadius = '8px';
      img.style.display = 'block';
      img.style.margin = '8px 0';
      return img;
    };

    if (!sel || sel.rangeCount === 0) {
      el.appendChild(createImg());
      el.appendChild(document.createElement('br'));
    } else {
      const range = sel.getRangeAt(0);
      if (el.contains(range.commonAncestorContainer)) {
        const img = createImg();
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(createImg());
        el.appendChild(document.createElement('br'));
      }
    }

    const html = el.innerHTML;
    checkEmpty();
    emitChange(html, embeds);
    saveDraft(html, embeds);
  }, [embeds, checkEmpty, emitChange, saveDraft]);

  const handleFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024);
    if (imageFiles.length === 0) return;

    setUploadTotal(prev => prev + imageFiles.length);

    const results = await Promise.all(
      imageFiles.map(async (file) => {
        const url = await uploadFile(file);
        setUploading(prev => prev + 1);
        return url;
      })
    );

    const newUrls = results.filter((u): u is string => u !== null);
    for (const url of newUrls) {
      insertImageAtCursor(url);
    }

    setTimeout(() => {
      setUploading(0);
      setUploadTotal(0);
    }, 500);
  }, [uploadFile, insertImageAtCursor]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFiles(files);
    e.target.value = '';
  }, [handleFiles]);

  // Intercept formatting shortcuts and paste
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(i => i.type.startsWith('image/'));

    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(i => i.getAsFile()).filter((f): f is File => f !== null);
      if (files.length > 0) handleFiles(files);
      return;
    }

    // Paste as plain text (strip formatting)
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        try {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const textNode = document.createTextNode(text);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {
          document.execCommand('insertText', false, text);
        }
      } else {
        document.execCommand('insertText', false, text);
      }
    }
  }, [handleFiles]);

  // ─── Video Embed ────────────────────────────────────────────────────────

  const handleVideoAdd = useCallback(() => {
    const embed = parseVideoUrl(videoUrl);
    if (!embed) {
      setVideoError('YouTube or Vimeo URL only');
      return;
    }
    if (embeds.some(e => e.videoId === embed.videoId)) {
      setVideoError('Already added');
      return;
    }
    const next = [...embeds, embed];
    setEmbeds(next);
    const html = editorRef.current?.innerHTML ?? '';
    emitChange(html, next);
    saveDraft(html, next);
    setVideoUrl('');
    setVideoError('');
    setShowVideoInput(false);
  }, [videoUrl, embeds, emitChange, saveDraft]);

  const removeEmbed = useCallback((index: number) => {
    setEmbeds(prev => {
      const next = prev.filter((_, i) => i !== index);
      const html = editorRef.current?.innerHTML ?? '';
      emitChange(html, next);
      saveDraft(html, next);
      return next;
    });
  }, [emitChange, saveDraft]);

  // ─── Drag & Drop ────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        border: `1px solid ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: '#111',
        transition: 'border-color 0.15s',
        ...(isDragging ? { boxShadow: '0 0 0 3px rgba(59,130,246,0.15)' } : {}),
      }}
    >
      {/* ContentEditable editor */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        data-placeholder={placeholder}
        style={{
          width: '100%',
          minHeight,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--foreground)',
          fontSize: 15,
          lineHeight: 1.85,
          fontFamily: "-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
          padding: '16px 18px 12px',
          boxSizing: 'border-box',
          display: 'block',
          wordBreak: 'keep-all',
          overflowWrap: 'break-word',
          whiteSpace: 'pre-wrap',
          position: 'relative',
        }}
      />

      {/* Drag overlay */}
      {isDragging && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(59,130,246,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          border: '2px dashed rgba(59,130,246,0.4)',
          borderRadius: 10,
          zIndex: 10,
        }}>
          <span style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 500 }}>이미지를 놓으세요</span>
        </div>
      )}

      {/* Video embed previews */}
      {embeds.length > 0 && (
        <div style={{ padding: '0 18px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {embeds.map((embed, i) => (
            <div key={embed.videoId} style={{
              position: 'relative',
              background: '#0a0a0a',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}>
              <div style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                background: embed.type === 'youtube' ? 'rgba(255,0,0,0.12)' : 'rgba(0,173,239,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 14 }}>{embed.type === 'youtube' ? '\u25B6' : '\u25B7'}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'capitalize' }}>
                  {embed.type}
                </div>
                <div style={{
                  fontSize: 11,
                  color: '#6b7280',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {embed.videoId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeEmbed(i)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#6b7280',
                  cursor: 'pointer',
                  padding: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Video URL input */}
      {showVideoInput && (
        <div style={{ padding: '0 18px 12px' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}>
            <input
              autoFocus
              type="url"
              value={videoUrl}
              onChange={(e) => { setVideoUrl(e.target.value); setVideoError(''); }}
              placeholder="YouTube or Vimeo URL"
              style={{
                flex: 1,
                background: '#0a0a0a',
                border: `1px solid ${videoError ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 7,
                color: '#e5e7eb',
                fontSize: 13,
                padding: '8px 12px',
                outline: 'none',
                fontFamily: 'inherit',
                transition: 'border-color 0.12s',
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') { setShowVideoInput(false); setVideoUrl(''); setVideoError(''); }
                if (e.key === 'Enter') { e.preventDefault(); handleVideoAdd(); }
              }}
            />
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleVideoAdd(); }}
              style={{
                background: 'var(--accent)',
                border: 'none',
                color: '#fff',
                borderRadius: 7,
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Add
            </button>
            <button type="button" onClick={() => { setShowVideoInput(false); setVideoUrl(''); setVideoError(''); }} style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#6b7280',
              borderRadius: 7,
              padding: '8px 12px',
              fontSize: 13,
              cursor: 'pointer',
              flexShrink: 0,
            }}>
              Cancel
            </button>
          </div>
          {videoError && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4, fontFamily: 'monospace' }}>
              {videoError}
            </div>
          )}
        </div>
      )}

      <UploadIndicator count={uploading} total={uploadTotal} />

      {/* Bottom toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '6px 12px',
        borderTop: '1px solid var(--border)',
        background: '#0d0d0d',
      }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Image / GIF"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#d1d5db'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9ca3af'; }}
        >
          <IconImage />
        </button>
        <button
          type="button"
          onClick={() => setShowVideoInput(v => !v)}
          title="Video link"
          style={{
            background: showVideoInput ? 'rgba(59,130,246,0.18)' : 'transparent',
            border: 'none',
            color: showVideoInput ? '#60a5fa' : '#9ca3af',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => { if (!showVideoInput) { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#d1d5db'; }}}
          onMouseLeave={(e) => { if (!showVideoInput) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#9ca3af'; }}}
        >
          <IconVideo />
        </button>

        <div style={{ flex: 1 }} />

        {saved && (
          <span style={{ fontSize: 11, color: '#4b5563', paddingRight: 4 }}>Draft saved</span>
        )}
        <span style={{
          fontSize: 11,
          color: charCount > 4800 ? '#ef4444' : '#4b5563',
          paddingRight: 4,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'monospace',
        }}>
          {charCount.toLocaleString()}
        </span>
      </div>

      {/* File input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,image/gif"
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        [contenteditable][data-placeholder]:empty::before {
          content: attr(data-placeholder);
          color: #4b5563;
          pointer-events: none;
          position: absolute;
          font-style: normal;
        }
        [contenteditable] img {
          max-width: 100%;
          height: auto;
          border-radius: 8px;
          display: block;
          margin: 8px 0;
        }
      `}</style>
    </div>
  );
}
