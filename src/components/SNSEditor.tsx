'use client';

import { useCallback, useRef, useState, useEffect } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSEditorProps {
  onChange?: (text: string, media: { images: string[]; embeds: Embed[] }) => void;
  placeholder?: string;
  minHeight?: number;
  draftKey?: string;
}

// ─── Video URL Detection ────────────────────────────────────────────────────

function parseVideoUrl(url: string): Embed | null {
  const trimmed = url.trim();

  // YouTube: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID
  const ytLong = trimmed.match(/(?:youtube\.com\/watch\?.*v=)([\w-]{11})/);
  if (ytLong) return { type: 'youtube', url: trimmed, videoId: ytLong[1] };

  const ytShort = trimmed.match(/(?:youtu\.be\/)([\w-]{11})/);
  if (ytShort) return { type: 'youtube', url: trimmed, videoId: ytShort[1] };

  const ytShorts = trimmed.match(/(?:youtube\.com\/shorts\/)([\w-]{11})/);
  if (ytShorts) return { type: 'youtube', url: trimmed, videoId: ytShorts[1] };

  // Vimeo: vimeo.com/ID
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
  text: string;
  images: string[];
  embeds: Embed[];
  savedAt: number;
}

function useDraftSave(draftKey: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  const saveDraft = useCallback((text: string, images: string[], embeds: Embed[]) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaved(false);
    timerRef.current = setTimeout(() => {
      try {
        if (text.trim() || images.length > 0 || embeds.length > 0) {
          localStorage.setItem(draftKey, JSON.stringify({ text, images, embeds, savedAt: Date.now() }));
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

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSEditor({
  onChange,
  placeholder = '내용을 입력하세요…',
  minHeight = 180,
  draftKey = 'zk-community-draft',
}: SNSEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [embeds, setEmbeds] = useState<Embed[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState('');

  const { saved, saveDraft, loadDraft, clearDraft } = useDraftSave(draftKey);

  // Fire onChange
  const emitChange = useCallback((t: string, imgs: string[], embs: Embed[]) => {
    onChange?.(t, { images: imgs, embeds: embs });
  }, [onChange]);

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(minHeight, ta.scrollHeight) + 'px';
  }, [minHeight]);

  // Load draft on mount
  const didLoadDraft = useRef(false);
  useEffect(() => {
    if (didLoadDraft.current) return;
    didLoadDraft.current = true;
    const draft = loadDraft();
    if (draft) {
      setText(draft.text);
      setImages(draft.images ?? []);
      setEmbeds(draft.embeds ?? []);
      emitChange(draft.text, draft.images ?? [], draft.embeds ?? []);
      setTimeout(autoResize, 0);
    }
  }, [loadDraft, emitChange, autoResize]);

  // Handle text change
  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    autoResize();
    emitChange(val, images, embeds);
    saveDraft(val, images, embeds);
  }, [images, embeds, autoResize, emitChange, saveDraft]);

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

  const handleFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024);
    if (imageFiles.length === 0) return;

    setUploadTotal(prev => prev + imageFiles.length);
    let completed = 0;

    const results = await Promise.all(
      imageFiles.map(async (file) => {
        const url = await uploadFile(file);
        completed++;
        setUploading(prev => prev + 1);
        return url;
      })
    );

    const newUrls = results.filter((u): u is string => u !== null);
    setImages(prev => {
      const next = [...prev, ...newUrls];
      emitChange(text, next, embeds);
      saveDraft(text, next, embeds);
      return next;
    });

    // Reset upload counters
    setTimeout(() => {
      setUploading(0);
      setUploadTotal(0);
    }, 500);
  }, [uploadFile, text, embeds, emitChange, saveDraft]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFiles(files);
    e.target.value = '';
  }, [handleFiles]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const next = prev.filter((_, i) => i !== index);
      emitChange(text, next, embeds);
      saveDraft(text, next, embeds);
      return next;
    });
  }, [text, embeds, emitChange, saveDraft]);

  // ─── Video Embed ────────────────────────────────────────────────────────

  const handleVideoSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const embed = parseVideoUrl(videoUrl);
    if (!embed) {
      setVideoError('YouTube or Vimeo URL only');
      return;
    }
    // No duplicates
    if (embeds.some(e => e.videoId === embed.videoId)) {
      setVideoError('Already added');
      return;
    }
    setEmbeds(prev => {
      const next = [...prev, embed];
      emitChange(text, images, next);
      saveDraft(text, images, next);
      return next;
    });
    setVideoUrl('');
    setVideoError('');
    setShowVideoInput(false);
  }, [videoUrl, embeds, text, images, emitChange, saveDraft]);

  const removeEmbed = useCallback((index: number) => {
    setEmbeds(prev => {
      const next = prev.filter((_, i) => i !== index);
      emitChange(text, images, next);
      saveDraft(text, images, next);
      return next;
    });
  }, [text, images, emitChange, saveDraft]);

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

  // ─── Clipboard Paste ────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter(i => i.type.startsWith('image/'));
      if (imageItems.length > 0) {
        e.preventDefault();
        const files = imageItems.map(i => i.getAsFile()).filter((f): f is File => f !== null);
        if (files.length > 0) handleFiles(files);
      }
    };
    el.addEventListener('paste', handlePaste);
    return () => el.removeEventListener('paste', handlePaste);
  }, [handleFiles]);

  // ─── Render ─────────────────────────────────────────────────────────────

  const charCount = text.length;

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
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleTextChange}
        placeholder={placeholder}
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
          resize: 'none',
          boxSizing: 'border-box',
          display: 'block',
          wordBreak: 'keep-all',
          overflowWrap: 'break-word',
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

      {/* Image thumbnails */}
      {images.length > 0 && (
        <div style={{
          padding: '0 18px 12px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}>
          {images.map((url, i) => (
            <div key={url + i} style={{ position: 'relative', width: 80, height: 80 }}>
              <img
                src={url}
                alt=""
                style={{
                  width: 80,
                  height: 80,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.08)',
                  display: 'block',
                }}
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: '#111',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  zIndex: 5,
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
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
                <span style={{ fontSize: 14 }}>{embed.type === 'youtube' ? '▶' : '▷'}</span>
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
        <div style={{ padding: '0 18px 12px' }}>
          <form onSubmit={handleVideoSubmit} style={{
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
              onKeyDown={(e) => { if (e.key === 'Escape') { setShowVideoInput(false); setVideoUrl(''); setVideoError(''); }}}
            />
            <button type="submit" style={{
              background: 'var(--accent)',
              border: 'none',
              color: '#fff',
              borderRadius: 7,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
            }}>
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
          </form>
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
      `}</style>
    </div>
  );
}
