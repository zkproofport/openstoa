'use client';

import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useCallback, useRef, useState, useEffect } from 'react';

// ─── Props Interface ────────────────────────────────────────────────────────

interface RichEditorProps {
  content?: string;
  contentJson?: Record<string, unknown> | null;
  onChange?: (html: string, json: Record<string, unknown>) => void;
  placeholder?: string;
  editable?: boolean;
  minHeight?: number;
  draftKey?: string; // localStorage key for auto-save
}

// ─── SVG Icons ──────────────────────────────────────────────────────────────

const IconBold = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2h5a3.5 3.5 0 0 1 2.45 5.98A3.5 3.5 0 0 1 9 14H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 5.5h4a1.5 1.5 0 1 0 0-3H5v3zm0 4.5h4a1.5 1.5 0 1 0 0-3H5v3z"/>
  </svg>
);

const IconItalic = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M7 2h5v2H9.72L7.28 12H10v2H4v-2h2.28L8.72 4H6V2z"/>
  </svg>
);

const IconStrike = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 5c-1.1 0-2 .4-2 1.2 0 .4.2.7.6.9H3.5a.5.5 0 0 0 0 1h9a.5.5 0 0 0 0-1h-2.1c.4-.2.6-.5.6-.9C11 5.4 10.1 5 8 5zm0 7c1.2 0 2.2-.5 2.7-1.3l-1.5-.5C8.9 10.6 8.5 10.8 8 10.8c-.9 0-1.5-.4-1.5-1H5c0 1.3 1.3 2.2 3 2.2z"/>
    <rect x="2" y="7.5" width="12" height="1" rx=".5"/>
  </svg>
);

const IconH2 = () => (
  <svg width="18" height="16" viewBox="0 0 18 16" fill="currentColor">
    <path d="M2 2h2v5h4V2h2v12H8V9H4v5H2V2z"/>
    <path d="M14 14v-2c0-1.1.9-2 2-2h.5c.8 0 1.5-.7 1.5-1.5S17.3 7 16.5 7H14V5h2.5C18 5 19 6 19 7.5S18 10 16.5 10H16a.5.5 0 0 0-.5.5V12H19v2h-5z"/>
  </svg>
);

const IconH3 = () => (
  <svg width="18" height="16" viewBox="0 0 18 16" fill="currentColor">
    <path d="M2 2h2v5h4V2h2v12H8V9H4v5H2V2z"/>
    <path d="M14 5h4.5v2H15v1.5h1.5c1.4 0 2.5 1.1 2.5 2.5S17.9 13.5 16.5 13.5H14V11.5h2.5c.3 0 .5-.2.5-.5s-.2-.5-.5-.5H14V5z"/>
  </svg>
);

const IconBulletList = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="2.5" cy="4" r="1.5"/>
    <rect x="5" y="3" width="9" height="2" rx="1"/>
    <circle cx="2.5" cy="8" r="1.5"/>
    <rect x="5" y="7" width="9" height="2" rx="1"/>
    <circle cx="2.5" cy="12" r="1.5"/>
    <rect x="5" y="11" width="9" height="2" rx="1"/>
  </svg>
);

const IconOrderedList = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1 3h1v2H1V3zm1 4H1v1h2V6H2zm-1 4h1v1H1v-1zm1 2H1v2h2v-2zm4-10h8v2H6V3zm0 4h8v2H6V7zm0 4h8v2H6v-2z"/>
  </svg>
);

const IconQuote = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3 4h3l-2 4h2v4H2V8l1-4zm6 0h3l-2 4h2v4H8V8l1-4z"/>
  </svg>
);

const IconCode = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.7 10.3L2.4 8l3.3-2.3-.8-1.4L1 8l3.9 3.7 1.8-1.4zm4.6 0l1.8 1.4L16 8l-3.9-3.7-1.8 1.4L13.6 8l-3.3 2.3z"/>
  </svg>
);

const IconLink = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M6.5 9.5a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-1 1 1.42 1.42.99-.99a1 1 0 0 1 1.42 1.42l-2 2a1 1 0 0 1-1.42 0l-.7-.7-1.42 1.42.71.67zM9.5 6.5a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l1-1-1.42-1.42-.99.99a1 1 0 0 1-1.42-1.42l2-2a1 1 0 0 1 1.42 0l.7.7 1.42-1.42-.71-.67z"/>
  </svg>
);

const IconImage = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M14 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zM2 4h12v5.5l-2.5-2.5-3 3-2-2L2 11.5V4zm0 8v-.5l4.5-4 2 2 3-3 2.5 2.5V12H2z"/>
    <circle cx="5" cy="6.5" r="1"/>
  </svg>
);

const IconUndo = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.5 6H10a4 4 0 0 1 0 8H7v-2h3a2 2 0 0 0 0-4H3.5l2 2-1.5 1.5L0 8l4-3.5L5.5 6l-2 0z"/>
  </svg>
);

const IconRedo = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M12.5 6H6a4 4 0 0 0 0 8h3v-2H6a2 2 0 0 1 0-4h6.5l-2 2 1.5 1.5L16 8l-4-3.5L10.5 6l2 0z"/>
  </svg>
);

const IconUnlink = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 2l12 12-1.4 1.4-2.1-2.1A3 3 0 0 1 6.5 9.5L4.4 7.4A3 3 0 0 1 8.5 3.5l-2.1-2 1.4-1.4L2 2zm9 5.5a3 3 0 0 0-.5-4.7l-1 1 1.42 1.42.08-.08a1 1 0 0 1 1.28 1.52L11 7.1l1.4 1.4.6-.6zM9.88 11.3l-1.42-1.42-.7.72a1 1 0 0 1-1.42-1.42l.71-.7L5.63 7.07l-.64.64a3 3 0 0 0 4.24 4.24l.65-.65z"/>
  </svg>
);

// ─── Floating Selection Toolbar ──────────────────────────────────────────────

interface FloatingToolbarProps {
  editor: Editor;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function FloatingToolbar({ editor, containerRef }: FloatingToolbarProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || !containerRef.current) {
        setPos(null);
        setLinkMode(false);
        return;
      }

      const domSel = window.getSelection();
      if (!domSel || domSel.rangeCount === 0) { setPos(null); return; }

      const range = domSel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = containerRef.current.getBoundingClientRect();

      if (rect.width === 0) { setPos(null); return; }

      const left = Math.max(0, rect.left - containerRect.left + rect.width / 2);
      const top = rect.top - containerRect.top - 44;

      setPos({ top, left });
    };

    document.addEventListener('selectionchange', updatePosition);
    editor.on('selectionUpdate', updatePosition);
    editor.on('blur', () => { setPos(null); setLinkMode(false); });

    return () => {
      document.removeEventListener('selectionchange', updatePosition);
      editor.off('selectionUpdate', updatePosition);
    };
  }, [editor, containerRef]);

  if (!pos) return null;

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: 'none',
    color: active ? 'var(--accent)' : '#e0e0e0',
    cursor: 'pointer',
    padding: '6px 9px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    transition: 'background 0.1s',
    minWidth: 32,
    minHeight: 32,
  });

  const sepStyle: React.CSSProperties = {
    width: 1,
    background: 'rgba(255,255,255,0.1)',
    margin: '6px 2px',
    flexShrink: 0,
  };

  const handleLinkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (linkValue.trim()) {
      const url = linkValue.startsWith('http') ? linkValue : `https://${linkValue}`;
      editor.chain().focus().setLink({ href: url }).run();
    }
    setLinkMode(false);
    setLinkValue('');
  };

  return (
    <div
      ref={toolbarRef}
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        transform: 'translateX(-50%)',
        zIndex: 100,
        background: '#1a1a1a',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        padding: '2px',
        animation: 'floatIn 0.12s ease',
        pointerEvents: 'auto',
        whiteSpace: 'nowrap',
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {linkMode ? (
        <form onSubmit={handleLinkSubmit} style={{ display: 'flex', alignItems: 'center', padding: '2px 6px', gap: 6 }}>
          <input
            autoFocus
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            placeholder="https://..."
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#e0e0e0',
              fontSize: 12,
              width: 180,
              fontFamily: 'inherit',
            }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setLinkMode(false); setLinkValue(''); }}}
          />
          <button type="submit" style={{ ...btnStyle(), color: 'var(--accent)', fontSize: 11, fontWeight: 600, padding: '4px 8px' }}>
            Add
          </button>
        </form>
      ) : (
        <>
          <button style={btnStyle(editor.isActive('bold'))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }} title="Bold (⌘B)"><IconBold /></button>
          <button style={btnStyle(editor.isActive('italic'))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }} title="Italic (⌘I)"><IconItalic /></button>
          <button style={btnStyle(editor.isActive('strike'))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }} title="Strikethrough"><IconStrike /></button>
          <div style={sepStyle} />
          <button
            style={btnStyle(editor.isActive('link'))}
            onMouseDown={(e) => {
              e.preventDefault();
              if (editor.isActive('link')) {
                editor.chain().focus().unsetLink().run();
              } else {
                setLinkMode(true);
              }
            }}
            title="Link"
          >
            {editor.isActive('link') ? <IconUnlink /> : <IconLink />}
          </button>
          <div style={sepStyle} />
          <button style={btnStyle(editor.isActive('heading', { level: 2 }))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }} title="Heading 2"><IconH2 /></button>
          <button style={btnStyle(editor.isActive('heading', { level: 3 }))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 3 }).run(); }} title="Heading 3"><IconH3 /></button>
          <div style={sepStyle} />
          <button style={btnStyle(editor.isActive('blockquote'))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }} title="Quote"><IconQuote /></button>
          <button style={btnStyle(editor.isActive('code'))} onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }} title="Inline Code"><IconCode /></button>
        </>
      )}
    </div>
  );
}

// ─── Toolbar Button ───────────────────────────────────────────────────────────

interface TBtnProps {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  shortcut?: string;
  isMobile?: boolean;
}

function TBtn({ active, onClick, children, title, disabled, shortcut, isMobile }: TBtnProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={title}
        style={{
          background: active ? 'rgba(59,130,246,0.18)' : hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
          color: active ? '#60a5fa' : disabled ? '#3a3a3a' : '#9ca3af',
          border: 'none',
          borderRadius: 6,
          padding: isMobile ? '10px 11px' : '6px 8px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: isMobile ? 44 : 32,
          minHeight: isMobile ? 44 : 32,
          transition: 'background 0.1s, color 0.1s',
          flexShrink: 0,
        }}
      >
        {children}
      </button>
      {hovered && !isMobile && shortcut && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 6,
          background: '#000',
          color: '#aaa',
          fontSize: 10,
          padding: '3px 7px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          border: '1px solid rgba(255,255,255,0.1)',
          zIndex: 50,
        }}>
          {title}{shortcut ? ` (${shortcut})` : ''}
        </div>
      )}
    </div>
  );
}

// ─── Upload State Overlay ─────────────────────────────────────────────────────

function UploadIndicator({ state }: { state: 'idle' | 'uploading' | 'error' }) {
  if (state === 'idle') return null;
  return (
    <div style={{
      position: 'absolute',
      bottom: 60,
      right: 12,
      background: state === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(17,17,17,0.95)',
      border: `1px solid ${state === 'error' ? '#ef4444' : 'rgba(59,130,246,0.4)'}`,
      color: state === 'error' ? '#fca5a5' : '#93c5fd',
      fontSize: 12,
      padding: '6px 12px',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      pointerEvents: 'none',
      zIndex: 20,
    }}>
      {state === 'uploading' && (
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 0.8s linear infinite' }}>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12"/>
        </svg>
      )}
      {state === 'error' ? 'Upload failed' : 'Uploading…'}
    </div>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────

const Divider = ({ isMobile }: { isMobile?: boolean }) => (
  <div style={{
    width: isMobile ? 1 : 1,
    height: isMobile ? 20 : 18,
    background: 'rgba(255,255,255,0.08)',
    flexShrink: 0,
    margin: isMobile ? '0 4px' : '0 2px',
  }} />
);

// ─── Draft Save Logic ─────────────────────────────────────────────────────────

function useDraftSave(editor: Editor | null, draftKey: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!editor) return;

    const handleUpdate = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setSaved(false);
      timerRef.current = setTimeout(() => {
        try {
          const json = editor.getJSON();
          const html = editor.getHTML();
          const isEmpty = editor.isEmpty;
          if (!isEmpty) {
            localStorage.setItem(draftKey, JSON.stringify({ json, html, savedAt: Date.now() }));
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          } else {
            localStorage.removeItem(draftKey);
          }
        } catch {}
      }, 1200);
    };

    editor.on('update', handleUpdate);
    return () => {
      editor.off('update', handleUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, draftKey]);

  const loadDraft = useCallback(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      return JSON.parse(raw) as { json: Record<string, unknown>; html: string; savedAt: number };
    } catch { return null; }
  }, [draftKey]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(draftKey); } catch {}
  }, [draftKey]);

  return { saved, loadDraft, clearDraft };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function RichEditor({
  content,
  contentJson,
  onChange,
  placeholder = '내용을 입력하세요…',
  editable = true,
  minHeight = 240,
  draftKey = 'zk-community-draft',
}: RichEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [charCount, setCharCount] = useState(0);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkInputValue, setLinkInputValue] = useState('');

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Image.configure({
        HTMLAttributes: {
          style: 'max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; display: block;',
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          style: 'color: var(--accent); text-decoration: underline; cursor: pointer;',
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: contentJson || content || '',
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const json = editor.getJSON();
      setCharCount(editor.storage.characterCount?.characters?.() ?? editor.getText().length);
      onChange?.(html, json as Record<string, unknown>);
    },
    onCreate: ({ editor }) => {
      setCharCount(editor.getText().length);
    },
  });

  const { saved, loadDraft, clearDraft } = useDraftSave(editable ? editor : null, draftKey);

  // Load draft on mount if no initial content
  const didLoadDraft = useRef(false);
  useEffect(() => {
    if (!editor || !editable || didLoadDraft.current) return;
    if (contentJson || content) return;
    didLoadDraft.current = true;
    const draft = loadDraft();
    if (draft) {
      const age = Date.now() - draft.savedAt;
      if (age < 24 * 60 * 60 * 1000) {
        editor.commands.setContent(draft.json as Record<string, unknown>);
      }
    }
  }, [editor, editable, content, contentJson, loadDraft]);

  const handleImageUpload = useCallback(async (file: File) => {
    if (!editor) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadState('error');
      setTimeout(() => setUploadState('idle'), 3000);
      return;
    }

    setUploadState('uploading');
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }

      const { uploadUrl, publicUrl } = await res.json();
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });

      if (!uploadRes.ok) throw new Error('R2 upload failed');
      editor.chain().focus().setImage({ src: publicUrl }).run();
      setUploadState('idle');
    } catch (err) {
      console.error('Image upload failed:', err);
      setUploadState('error');
      setTimeout(() => setUploadState('idle'), 3000);
    }
  }, [editor]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImageUpload(file);
    e.target.value = '';
  }, [handleImageUpload]);

  // Drag & drop
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
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) handleImageUpload(file);
  }, [handleImageUpload]);

  // Clipboard paste
  useEffect(() => {
    if (!editor || !editable) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find(i => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) handleImageUpload(file);
      }
    };
    const el = containerRef.current;
    el?.addEventListener('paste', handlePaste);
    return () => el?.removeEventListener('paste', handlePaste);
  }, [editor, editable, handleImageUpload]);

  const handleLinkSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!editor || !linkInputValue.trim()) return;
    const url = linkInputValue.startsWith('http') ? linkInputValue : `https://${linkInputValue}`;
    editor.chain().focus().setLink({ href: url }).run();
    setLinkDialogOpen(false);
    setLinkInputValue('');
  }, [editor, linkInputValue]);

  if (!editor) return null;

  const mobile = isMobile;

  // ─── Toolbar Groups ────────────────────────────────────────────────────────

  const textGroup = (
    <>
      <TBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold" shortcut="⌘B" isMobile={mobile}><IconBold /></TBtn>
      <TBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic" shortcut="⌘I" isMobile={mobile}><IconItalic /></TBtn>
      <TBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strike" isMobile={mobile}><IconStrike /></TBtn>
    </>
  );

  const headingGroup = (
    <>
      <TBtn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2" isMobile={mobile}><IconH2 /></TBtn>
      <TBtn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3" isMobile={mobile}><IconH3 /></TBtn>
    </>
  );

  const listGroup = (
    <>
      <TBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List" isMobile={mobile}><IconBulletList /></TBtn>
      <TBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered List" isMobile={mobile}><IconOrderedList /></TBtn>
      <TBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote" isMobile={mobile}><IconQuote /></TBtn>
      <TBtn active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code Block" shortcut="⌘⇧C" isMobile={mobile}><IconCode /></TBtn>
    </>
  );

  const insertGroup = (
    <>
      <TBtn
        active={editor.isActive('link')}
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
          } else {
            setLinkDialogOpen(true);
          }
        }}
        title="Link"
        shortcut="⌘K"
        isMobile={mobile}
      >
        {editor.isActive('link') ? <IconUnlink /> : <IconLink />}
      </TBtn>
      <TBtn onClick={() => fileInputRef.current?.click()} title="Image" isMobile={mobile}><IconImage /></TBtn>
    </>
  );

  const historyGroup = (
    <>
      <TBtn disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} title="Undo" shortcut="⌘Z" isMobile={mobile}><IconUndo /></TBtn>
      <TBtn disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} title="Redo" shortcut="⌘⇧Z" isMobile={mobile}><IconRedo /></TBtn>
    </>
  );

  // ─── Render ────────────────────────────────────────────────────────────────

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
      {/* ── Desktop Toolbar (top) ── */}
      {editable && !mobile && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '4px 8px',
          borderBottom: '1px solid var(--border)',
          background: '#0d0d0d',
          flexWrap: 'wrap',
        }}>
          {textGroup}
          <Divider />
          {headingGroup}
          <Divider />
          {listGroup}
          <Divider />
          {insertGroup}
          <Divider />
          {historyGroup}
          <div style={{ flex: 1 }} />
          {saved && (
            <span style={{ fontSize: 11, color: '#4b5563', paddingRight: 4 }}>Draft saved</span>
          )}
          <span style={{
            fontSize: 11,
            color: charCount > 4800 ? '#ef4444' : '#4b5563',
            paddingRight: 4,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {charCount.toLocaleString()}
          </span>
        </div>
      )}

      {/* ── Floating Selection Toolbar ── */}
      {editable && !mobile && (
        <FloatingToolbar editor={editor} containerRef={containerRef} />
      )}

      {/* ── Editor Content ── */}
      <div style={{ position: 'relative' }}>
        <EditorContent
          editor={editor}
          style={{ minHeight, padding: mobile ? '14px 14px 70px' : '16px 18px 16px' }}
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
          }}>
            <span style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 500 }}>이미지를 놓으세요</span>
          </div>
        )}
      </div>

      <UploadIndicator state={uploadState} />

      {/* ── Link Dialog ── */}
      {linkDialogOpen && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
            backdropFilter: 'blur(4px)',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setLinkDialogOpen(false); setLinkInputValue(''); }}}
        >
          <form
            onSubmit={handleLinkSubmit}
            style={{
              background: '#161616',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              padding: '20px 24px',
              width: 'min(360px, 90vw)',
              boxShadow: '0 16px 40px rgba(0,0,0,0.7)',
            }}
          >
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12, fontWeight: 500, letterSpacing: '0.02em' }}>링크 추가</div>
            <input
              autoFocus
              type="url"
              value={linkInputValue}
              onChange={(e) => setLinkInputValue(e.target.value)}
              placeholder="https://example.com"
              style={{
                width: '100%',
                background: '#0a0a0a',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 7,
                color: '#e5e7eb',
                fontSize: 14,
                padding: '9px 12px',
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                transition: 'border-color 0.12s',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setLinkDialogOpen(false); setLinkInputValue(''); }}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#6b7280',
                  borderRadius: 7,
                  padding: '7px 16px',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                취소
              </button>
              <button
                type="submit"
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 7,
                  padding: '7px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                추가
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Mobile Bottom Toolbar ── */}
      {editable && mobile && (
        <div style={{
          position: 'sticky',
          bottom: 0,
          left: 0,
          right: 0,
          borderTop: '1px solid var(--border)',
          background: '#0d0d0d',
          display: 'flex',
          alignItems: 'center',
          overflowX: 'auto',
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          padding: '2px 6px',
          gap: 0,
        }}>
          {textGroup}
          <Divider isMobile />
          {headingGroup}
          <Divider isMobile />
          {listGroup}
          <Divider isMobile />
          {insertGroup}
          <Divider isMobile />
          {historyGroup}
          <div style={{ flex: 1, minWidth: 8 }} />
          <span style={{
            fontSize: 11,
            color: charCount > 4800 ? '#ef4444' : '#374151',
            paddingRight: 8,
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {charCount}
          </span>
        </div>
      )}

      {/* ── File Input ── */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {/* ── Styles ── */}
      <style>{`
        @keyframes floatIn {
          from { opacity: 0; transform: translateX(-50%) translateY(4px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Tiptap editor reset + design */
        .tiptap {
          outline: none;
          color: var(--foreground);
          font-size: 15px;
          line-height: 1.85;
          font-family: -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
          word-break: keep-all;
          overflow-wrap: break-word;
        }

        /* Placeholder */
        .tiptap p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #374151;
          pointer-events: none;
          height: 0;
          font-size: 15px;
        }

        /* Headings */
        .tiptap h2 {
          font-size: 20px;
          font-weight: 700;
          margin: 24px 0 8px;
          letter-spacing: -0.025em;
          color: #f1f5f9;
          line-height: 1.3;
        }
        .tiptap h3 {
          font-size: 17px;
          font-weight: 600;
          margin: 18px 0 6px;
          letter-spacing: -0.015em;
          color: #e2e8f0;
          line-height: 1.4;
        }

        /* Paragraphs */
        .tiptap p {
          margin: 0 0 10px;
        }
        .tiptap p:last-child {
          margin-bottom: 0;
        }

        /* Lists */
        .tiptap ul,
        .tiptap ol {
          padding-left: 22px;
          margin: 8px 0 12px;
        }
        .tiptap li {
          margin: 3px 0;
          line-height: 1.75;
        }
        .tiptap li > p {
          margin: 0;
        }
        .tiptap ul li::marker {
          color: #4b5563;
        }
        .tiptap ol li::marker {
          color: #4b5563;
          font-size: 13px;
        }

        /* Blockquote */
        .tiptap blockquote {
          border-left: 3px solid var(--accent);
          padding: 4px 0 4px 16px;
          margin: 14px 0;
          color: #9ca3af;
          font-style: italic;
          position: relative;
        }

        /* Code blocks */
        .tiptap pre {
          background: #0a0a0a;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 8px;
          padding: 14px 16px;
          font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
          font-size: 13px;
          overflow-x: auto;
          margin: 14px 0;
          line-height: 1.7;
          tab-size: 2;
        }
        .tiptap code {
          background: rgba(59,130,246,0.1);
          border: 1px solid rgba(59,130,246,0.15);
          padding: 1px 5px;
          border-radius: 4px;
          font-family: 'SF Mono', 'Fira Code', monospace;
          font-size: 12.5px;
          color: #93c5fd;
        }
        .tiptap pre code {
          background: none;
          border: none;
          padding: 0;
          color: #d1d5db;
          font-size: 13px;
        }

        /* Images */
        .tiptap img {
          max-width: 100%;
          height: auto;
          border-radius: 8px;
          margin: 14px 0;
          display: block;
          border: 1px solid rgba(255,255,255,0.06);
        }
        .tiptap img.ProseMirror-selectednode {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        /* Links */
        .tiptap a {
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 2px;
          text-decoration-color: rgba(59,130,246,0.4);
          transition: text-decoration-color 0.12s;
        }
        .tiptap a:hover {
          text-decoration-color: var(--accent);
        }

        /* Horizontal rule */
        .tiptap hr {
          border: none;
          border-top: 1px solid rgba(255,255,255,0.07);
          margin: 22px 0;
        }

        /* Hashtag highlight (post-processing via class on spans) */
        .tiptap .hashtag {
          color: var(--accent);
          font-weight: 500;
        }

        /* Selection */
        .tiptap ::selection {
          background: rgba(59,130,246,0.25);
        }

        /* Mobile toolbar scrollbar hide */
        .tiptap-mobile-toolbar::-webkit-scrollbar {
          display: none;
        }

        /* ProseMirror gap cursor */
        .ProseMirror .ProseMirror-gapcursor:after {
          border-top: 2px solid var(--accent);
        }

        /* Focus ring for accessibility */
        .tiptap:focus-visible {
          outline: none;
        }
      `}</style>
    </div>
  );
}
