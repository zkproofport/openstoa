'use client';

import { useCallback, useRef, useState, useEffect } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SNSEditorState {
  content: string;
  images: string[];
  videos: string[];
}

interface SNSEditorProps {
  onChange?: (state: SNSEditorState) => void;
  placeholder?: string;
  minHeight?: number;
  draftKey?: string;
  /** Cap on how many image URLs can live in `images` at once. Default 10
   *  to match mobile-side composer rules. */
  maxImages?: number;
  /** Cap on how many video URLs can live in `videos`. Default 3. */
  maxVideos?: number;
  /** Initial state to hydrate the editor from (used for the edit form so
   *  the user sees the post's current body/media). When set, the draft
   *  autoload is skipped so an in-progress draft doesn't trample the
   *  post being edited. */
  initialState?: SNSEditorState;
  /** Bump this number from the parent to force the editor's internal
   *  content/images/videos state back to empty. Used by the topic-page
   *  Reset button so the textarea visually clears even though the editor
   *  owns its own state (uncontrolled `content`). The effect runs only
   *  when the signal value changes, so the very first render — when
   *  parents typically pass `0` — does NOT trigger a wipe. */
  resetSignal?: number;
}

// ─── Video URL Validation ──────────────────────────────────────────────────

function isVideoUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/(?:youtube\.com\/watch\?.*v=)([\w-]{11})/.test(trimmed)) return true;
  if (/(?:youtu\.be\/)([\w-]{11})/.test(trimmed)) return true;
  if (/(?:youtube\.com\/shorts\/)([\w-]{11})/.test(trimmed)) return true;
  if (/(?:vimeo\.com\/)(\d+)/.test(trimmed)) return true;
  return false;
}

function describeVideo(url: string): string {
  const yt = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
  if (yt) return `YouTube · ${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `Vimeo · ${vimeo[1]}`;
  return url;
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
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="3" x2="9" y2="9" />
    <line x1="9" y1="3" x2="3" y2="9" />
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
  content: string;
  images: string[];
  videos: string[];
  savedAt: number;
}

function useDraftSave(draftKey: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  const saveDraft = useCallback((state: { content: string; images: string[]; videos: string[] }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaved(false);
    timerRef.current = setTimeout(() => {
      try {
        const hasAny = state.content.trim() || state.images.length > 0 || state.videos.length > 0;
        if (hasAny) {
          localStorage.setItem(draftKey, JSON.stringify({
            content: state.content,
            images: state.images,
            videos: state.videos,
            savedAt: Date.now(),
          }));
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
      const data = JSON.parse(raw) as Partial<DraftData> & { html?: string };
      const savedAt = typeof data.savedAt === 'number' ? data.savedAt : 0;
      const age = Date.now() - savedAt;
      if (age > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(draftKey);
        return null;
      }
      // Legacy drafts stored { html, savedAt } — best-effort migration: strip tags.
      if (typeof data.html === 'string' && typeof data.content !== 'string') {
        const text = data.html
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div)>/gi, '\n')
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        return { content: text.trim(), images: [], videos: [], savedAt };
      }
      return {
        content: typeof data.content === 'string' ? data.content : '',
        images: Array.isArray(data.images) ? data.images.filter((x): x is string => typeof x === 'string') : [],
        videos: Array.isArray(data.videos) ? data.videos.filter((x): x is string => typeof x === 'string') : [],
        savedAt,
      };
    } catch { return null; }
  }, [draftKey]);

  return { saved, saveDraft, loadDraft };
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSEditor({
  onChange,
  placeholder = 'Write something…',
  minHeight = 180,
  draftKey = 'openstoa-draft',
  maxImages = 10,
  maxVideos = 3,
  initialState,
  resetSignal,
}: SNSEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [content, setContent] = useState(initialState?.content ?? '');
  const [images, setImages] = useState<string[]>(initialState?.images ?? []);
  const [videos, setVideos] = useState<string[]>(initialState?.videos ?? []);
  const [limitError, setLimitError] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoUrlDraft, setVideoUrlDraft] = useState('');
  const [videoError, setVideoError] = useState('');

  const { saved, saveDraft, loadDraft } = useDraftSave(draftKey);

  // Emit unified state whenever any piece changes.
  const emit = useCallback((next: { content: string; images: string[]; videos: string[] }) => {
    onChange?.(next);
    saveDraft(next);
  }, [onChange, saveDraft]);

  // Auto-grow textarea to fit content.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  // Load draft on mount — skip when an initialState is supplied (edit form
  // shouldn't be trampled by an in-progress draft).
  const didLoadDraft = useRef(false);
  useEffect(() => {
    if (didLoadDraft.current) return;
    didLoadDraft.current = true;
    if (initialState) {
      // Defer the autoGrow until after the initial paint.
      setTimeout(autoGrow, 0);
      return;
    }
    const draft = loadDraft();
    if (draft) {
      setContent(draft.content);
      setImages(draft.images);
      setVideos(draft.videos);
      onChange?.({ content: draft.content, images: draft.images, videos: draft.videos });
      // Defer to next tick so textarea sees the new value.
      setTimeout(autoGrow, 0);
    }
  }, [loadDraft, onChange, autoGrow, initialState]);

  // When `draftKey` changes mid-mount (e.g. the parent stays mounted but
  // switches the per-topic draft slot), re-hydrate from the new key so the
  // user sees the right topic's saved draft instead of stale content from
  // the previous one. We deliberately re-run on draftKey changes only.
  const prevDraftKey = useRef(draftKey);
  useEffect(() => {
    if (prevDraftKey.current === draftKey) return;
    prevDraftKey.current = draftKey;
    if (initialState) return;
    const draft = loadDraft();
    if (draft) {
      setContent(draft.content);
      setImages(draft.images);
      setVideos(draft.videos);
      onChange?.({ content: draft.content, images: draft.images, videos: draft.videos });
    } else {
      setContent('');
      setImages([]);
      setVideos([]);
      onChange?.({ content: '', images: [], videos: [] });
    }
    setTimeout(autoGrow, 0);
  }, [draftKey, loadDraft, onChange, autoGrow, initialState]);

  // Reset signal — parent bumps the number to wipe the editor visually.
  // Compared with the previous value so the initial mount (e.g. signal=0)
  // doesn't clobber a freshly loaded draft.
  const prevResetSignal = useRef<number | undefined>(resetSignal);
  useEffect(() => {
    if (resetSignal === undefined) return;
    if (prevResetSignal.current === resetSignal) return;
    prevResetSignal.current = resetSignal;
    setContent('');
    setImages([]);
    setVideos([]);
    setLimitError(null);
    setShowVideoInput(false);
    setVideoUrlDraft('');
    setVideoError('');
    // Notify parent so its mirror state (postContent etc.) stays in sync —
    // some callers read these out of `onChange` rather than re-deriving.
    onChange?.({ content: '', images: [], videos: [] });
    // Drop the persisted draft for this key too — Reset shouldn't leave
    // a stale entry that the next mount would resurrect.
    try { localStorage.removeItem(draftKey); } catch {}
    setTimeout(autoGrow, 0);
  }, [resetSignal, onChange, autoGrow, draftKey]);

  // ─── Content updates ────────────────────────────────────────────────────

  const handleContentChange = useCallback((next: string) => {
    setContent(next);
    emit({ content: next, images, videos });
    // Defer so the new value is already in the DOM before measuring.
    setTimeout(autoGrow, 0);
  }, [emit, images, videos, autoGrow]);

  const updateImages = useCallback((next: string[]) => {
    setImages(next);
    emit({ content, images: next, videos });
  }, [emit, content, videos]);

  const updateVideos = useCallback((next: string[]) => {
    setVideos(next);
    emit({ content, images, videos: next });
  }, [emit, content, images]);

  // ─── Image Upload ───────────────────────────────────────────────────────

  const uploadFile = useCallback(async (file: File): Promise<string | null> => {
    if (!file.type.startsWith('image/')) return null;
    if (file.size > 10 * 1024 * 1024) return null;

    try {
      // POST /api/upload accepts multipart/form-data and uploads through the
      // server (since f4a6877 — direct-multipart replaced the prior
      // presigned-URL flow). Browser auth flows over the session cookie
      // attached automatically; no manual Authorization header here.
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('purpose', 'post');

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const { publicUrl } = (await res.json()) as { publicUrl: string };
      return publicUrl;
    } catch (err) {
      console.error('Image upload failed:', err);
      return null;
    }
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024);
    if (imageFiles.length === 0) return;

    // Cap batched uploads at the remaining slot count. Surface a
    // soft inline error when the user picks more than will fit so the
    // outcome isn't silent.
    const remainingSlots = Math.max(0, maxImages - images.length);
    if (remainingSlots === 0) {
      const msg = `Image limit reached (${maxImages}).`;
      setLimitError(msg);
      try { window.alert(msg); } catch {}
      setTimeout(() => setLimitError(null), 3000);
      return;
    }
    const trimmed = imageFiles.slice(0, remainingSlots);
    if (trimmed.length < imageFiles.length) {
      const msg = `Only ${remainingSlots} more image${remainingSlots === 1 ? '' : 's'} allowed (max ${maxImages}).`;
      setLimitError(msg);
      try { window.alert(msg); } catch {}
      setTimeout(() => setLimitError(null), 3000);
    }

    setUploadTotal(prev => prev + trimmed.length);

    const results = await Promise.all(
      trimmed.map(async (file) => {
        const url = await uploadFile(file);
        setUploading(prev => prev + 1);
        return url;
      })
    );

    const newUrls = results.filter((u): u is string => u !== null);
    if (newUrls.length > 0) {
      const nextImages = [...images, ...newUrls];
      setImages(nextImages);
      emit({ content, images: nextImages, videos });
    }

    setTimeout(() => {
      setUploading(0);
      setUploadTotal(0);
    }, 500);
  }, [uploadFile, images, content, videos, emit, maxImages]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFiles(files);
    e.target.value = '';
  }, [handleFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(i => i.type.startsWith('image/'));

    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(i => i.getAsFile()).filter((f): f is File => f !== null);
      if (files.length > 0) handleFiles(files);
    }
    // Otherwise let the textarea handle paste normally.
  }, [handleFiles]);

  // ─── Video URL Insert ─────────────────────────────────────────────────

  const handleVideoAdd = useCallback(() => {
    const url = videoUrlDraft.trim();
    if (!url) return;
    if (!isVideoUrl(url)) {
      setVideoError('YouTube or Vimeo URL only');
      return;
    }
    if (videos.includes(url)) {
      setVideoError('Already added');
      return;
    }
    if (videos.length >= maxVideos) {
      const msg = `Video limit reached (${maxVideos}).`;
      setVideoError(msg);
      try { window.alert(msg); } catch {}
      return;
    }
    const nextVideos = [...videos, url];
    setVideos(nextVideos);
    emit({ content, images, videos: nextVideos });
    setVideoUrlDraft('');
    setVideoError('');
    setShowVideoInput(false);
  }, [videoUrlDraft, videos, content, images, emit, maxVideos]);

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

  const charCount = content.length;

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
      {/* Plain textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
        onPaste={handlePaste}
        placeholder={placeholder}
        rows={1}
        style={{
          width: '100%',
          minHeight,
          resize: 'none',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--foreground)',
          fontSize: 15,
          lineHeight: 1.85,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
          padding: '16px 18px 12px',
          boxSizing: 'border-box',
          display: 'block',
          wordBreak: 'keep-all',
          overflowWrap: 'break-word',
          whiteSpace: 'pre-wrap',
        }}
      />

      {/* Image thumbnails */}
      {images.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          padding: '0 18px 12px',
        }}>
          {images.map((url, i) => (
            <div
              key={`${url}-${i}`}
              style={{
                position: 'relative',
                width: 96,
                height: 96,
                borderRadius: 8,
                overflow: 'hidden',
                background: '#0a0a0a',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <img
                src={url}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => updateImages(images.filter((_, idx) => idx !== i))}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'rgba(0,0,0,0.7)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Video chips */}
      {videos.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '0 18px 12px',
        }}>
          {videos.map((url, i) => (
            <div
              key={`${url}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                background: '#0a0a0a',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              <span style={{ color: '#9ca3af', flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {describeVideo(url)}
              </span>
              <button
                type="button"
                aria-label="Remove video"
                onClick={() => updateVideos(videos.filter((_, idx) => idx !== i))}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}

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
          <span style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 500 }}>Drop image here</span>
        </div>
      )}

      {/* Video URL input */}
      {showVideoInput && (
        <div style={{ padding: '0 18px 12px' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              autoFocus
              type="url"
              value={videoUrlDraft}
              onChange={(e) => { setVideoUrlDraft(e.target.value); setVideoError(''); }}
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
                if (e.key === 'Escape') { setShowVideoInput(false); setVideoUrlDraft(''); setVideoError(''); }
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
            <button
              type="button"
              onClick={() => { setShowVideoInput(false); setVideoUrlDraft(''); setVideoError(''); }}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#6b7280',
                borderRadius: 7,
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
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

      {limitError && (
        <div style={{
          padding: '6px 18px 8px',
          fontSize: 11,
          color: '#ef4444',
          fontFamily: 'monospace',
        }}>
          {limitError}
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
