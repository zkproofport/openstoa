'use client';

import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

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
  /** Cap on how many image URLs can live in `images` at once. Default 10
   *  to match mobile-side composer rules. */
  maxImages?: number;
  /** Cap on how many video URLs can live in `videos`. Default 3. */
  maxVideos?: number;
  /** Initial state to hydrate the editor from (used for the edit form so
   *  the user sees the post's current body/media). */
  initialState?: SNSEditorState;
  /**
   * The topic being composed in. Sent with each upload so the image is filed
   * under `topics/{id}/` and a topic deletion reaches it (M-3). Omitted only
   * where there is genuinely no topic yet — the object then lands under the
   * uploader and survives the topic's deletion.
   */
  topicId?: string;
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
  const { t } = useTranslation();
  if (total === 0) return null;
  return (
    <div style={{
      position: 'absolute',
      bottom: 60,
      right: 12,
      background: 'color-mix(in srgb, var(--color-bg-secondary) 95%, transparent)',
      border: '1px solid var(--color-brand-primary)',
      color: 'var(--color-brand-primary)',
      fontSize: 'var(--text-label)',
      padding: '6px 12px',
      borderRadius: 'var(--radius-control)',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      pointerEvents: 'none',
      zIndex: 20,
    }}>
      <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 0.8s linear infinite' }}>
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
      </svg>
      {t('snsEditor.uploading', { count, total })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSEditor({
  onChange,
  placeholder,
  minHeight = 180,
  maxImages = 10,
  maxVideos = 3,
  initialState,
  topicId,
}: SNSEditorProps) {
  const { t } = useTranslation();
  const effectivePlaceholder = placeholder ?? t('snsEditor.placeholder');
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

  // Emit unified state whenever any piece changes.
  const emit = useCallback((next: { content: string; images: string[]; videos: string[] }) => {
    onChange?.(next);
  }, [onChange]);

  // Auto-grow textarea to fit content.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  // On mount, defer autoGrow so the textarea sees the initial value.
  useEffect(() => {
    setTimeout(autoGrow, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Files the object under the topic, so deleting the topic deletes it.
      if (topicId) form.append('topicId', topicId);

      const res = await apiFetch('/api/upload', {
      // A multi-megabyte body going up: the ordinary deadline covers the
      // WHOLE exchange, so 15s would cut off a transfer that is making progress.
      timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
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
      const msg = t('snsEditor.imageLimitReached', { max: maxImages });
      setLimitError(msg);
      try { window.alert(msg); } catch {}
      setTimeout(() => setLimitError(null), 3000);
      return;
    }
    const trimmed = imageFiles.slice(0, remainingSlots);
    if (trimmed.length < imageFiles.length) {
      const msg = t('snsEditor.imageLimitPartial', {
        remaining: remainingSlots,
        max: maxImages,
        suffix: remainingSlots === 1 ? '' : 's',
      });
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
      setVideoError(t('snsEditor.videoUrlOnly'));
      return;
    }
    if (videos.includes(url)) {
      setVideoError(t('snsEditor.videoAlreadyAdded'));
      return;
    }
    if (videos.length >= maxVideos) {
      const msg = t('snsEditor.videoLimitReached', { max: maxVideos });
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
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        background: 'var(--color-bg-secondary)',
        transition: 'border-color 0.15s',
        ...(isDragging ? { boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-brand-primary) 15%, transparent)' } : {}),
      }}
    >
      {/* Plain textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
        onPaste={handlePaste}
        placeholder={effectivePlaceholder}
        rows={1}
        style={{
          width: '100%',
          minHeight,
          resize: 'none',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--foreground)',
          // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
          fontSize: 'var(--text-body)',
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
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              <img
                src={url}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              <button
                type="button"
                aria-label={t('snsEditor.removeImage')}
                onClick={() => updateImages(images.filter((_, idx) => idx !== i))}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'rgba(0,0,0,0.7)',
                  border: '1px solid var(--color-border-default)',
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
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 8,
                fontSize: 'var(--text-caption)',
              }}
            >
              <span style={{ color: 'var(--color-text-secondary)', flex: 1, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {describeVideo(url)}
              </span>
              <button
                type="button"
                aria-label={t('snsEditor.removeVideo')}
                onClick={() => updateVideos(videos.filter((_, idx) => idx !== i))}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border-default)',
                  color: 'var(--color-text-secondary)',
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
          background: 'color-mix(in srgb, var(--color-brand-primary) 8%, transparent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          border: '2px dashed color-mix(in srgb, var(--color-brand-primary) 40%, transparent)',
          borderRadius: 10,
          zIndex: 10,
        }}>
          <span style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)', fontWeight: 500 }}>{t('snsEditor.dropImageHere')}</span>
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
              placeholder={t('snsEditor.videoUrlPlaceholder')}
              style={{
                flex: 1,
                background: 'var(--color-bg-primary)',
                border: `1px solid ${videoError ? 'color-mix(in srgb, var(--color-status-danger) 40%, transparent)' : 'var(--color-bg-tertiary)'}`,
                borderRadius: 7,
                color: 'var(--color-text-primary)',
                // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
                fontSize: 'var(--text-body)',
                padding: 'var(--space-2) var(--space-3)',
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
                color: 'var(--color-text-inverted)',
                borderRadius: 7,
                padding: 'var(--space-2) 14px',
                fontSize: 'var(--text-caption)',
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              {t('common.add')}
            </button>
            <button
              type="button"
              onClick={() => { setShowVideoInput(false); setVideoUrlDraft(''); setVideoError(''); }}
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-default)',
                color: 'var(--color-text-tertiary)',
                borderRadius: 7,
                padding: 'var(--space-2) var(--space-3)',
                fontSize: 'var(--text-caption)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
          {videoError && (
            <div style={{ fontSize: 11, color: 'var(--color-status-danger)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
              {videoError}
            </div>
          )}
        </div>
      )}

      {limitError && (
        <div style={{
          padding: '6px 18px 8px',
          fontSize: 11,
          color: 'var(--color-status-danger)',
          fontFamily: 'var(--font-mono)',
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
        background: 'var(--color-bg-primary)',
      }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title={t('snsEditor.imageGifTitle')}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-secondary)',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: 'var(--radius-control)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
        >
          <IconImage />
        </button>
        <button
          type="button"
          onClick={() => setShowVideoInput(v => !v)}
          title={t('snsEditor.videoLinkTitle')}
          style={{
            background: showVideoInput ? 'var(--color-brand-primary-muted)' : 'transparent',
            border: 'none',
            color: showVideoInput ? 'var(--color-brand-primary)' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: 'var(--radius-control)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => { if (!showVideoInput) { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text-primary)'; }}}
          onMouseLeave={(e) => { if (!showVideoInput) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}}
        >
          <IconVideo />
        </button>

        <div style={{ flex: 1 }} />

        <span style={{
          fontSize: 11,
          color: charCount > 4800 ? 'var(--color-status-danger)' : 'var(--color-text-tertiary)',
          paddingRight: 4,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--font-mono)',
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
