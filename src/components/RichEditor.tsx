'use client';

import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useCallback, useRef } from 'react';

interface RichEditorProps {
  content?: string;
  contentJson?: Record<string, unknown> | null;
  onChange?: (html: string, json: Record<string, unknown>) => void;
  placeholder?: string;
  editable?: boolean;
  minHeight?: number;
}

export default function RichEditor({ content, contentJson, onChange, placeholder = 'Write something...', editable = true, minHeight = 200 }: RichEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Image.configure({
        HTMLAttributes: {
          style: 'max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0;',
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          style: 'color: var(--accent); text-decoration: underline;',
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
    ],
    content: contentJson || content || '',
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML(), editor.getJSON() as Record<string, unknown>);
    },
  });

  const handleImageUpload = useCallback(async (file: File) => {
    if (!editor) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      alert('Image must be less than 10MB');
      return;
    }

    try {
      // Get presigned URL
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          size: file.size,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }

      const { uploadUrl, publicUrl } = await res.json();

      // Upload to R2
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });

      if (!uploadRes.ok) throw new Error('Failed to upload image');

      // Insert image into editor
      editor.chain().focus().setImage({ src: publicUrl }).run();
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  }, [editor]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImageUpload(file);
    e.target.value = '';
  }, [handleImageUpload]);

  if (!editor) return null;

  // Toolbar button helper
  const ToolbarButton = ({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title: string }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        border: '1px solid transparent',
        borderRadius: 5,
        padding: '4px 8px',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1,
        transition: 'all 0.12s',
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: '#111' }}>
      {editable && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          padding: '6px 8px',
          borderBottom: '1px solid var(--border)',
          background: '#0d0d0d',
        }}>
          <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">B</ToolbarButton>
          <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><em>I</em></ToolbarButton>
          <ToolbarButton active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough"><s>S</s></ToolbarButton>
          <div style={{ width: 1, background: 'var(--border)', margin: '2px 4px' }} />
          <ToolbarButton active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">H2</ToolbarButton>
          <ToolbarButton active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">H3</ToolbarButton>
          <div style={{ width: 1, background: 'var(--border)', margin: '2px 4px' }} />
          <ToolbarButton active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List">•</ToolbarButton>
          <ToolbarButton active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered List">1.</ToolbarButton>
          <ToolbarButton active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">"</ToolbarButton>
          <ToolbarButton active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code Block">&lt;/&gt;</ToolbarButton>
          <div style={{ width: 1, background: 'var(--border)', margin: '2px 4px' }} />
          <ToolbarButton onClick={() => {
            const url = window.prompt('Enter URL');
            if (url) editor.chain().focus().setLink({ href: url }).run();
          }} title="Link" active={editor.isActive('link')}>🔗</ToolbarButton>
          <ToolbarButton onClick={() => fileInputRef.current?.click()} title="Image">📷</ToolbarButton>
          <div style={{ width: 1, background: 'var(--border)', margin: '2px 4px' }} />
          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo">↩</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo">↪</ToolbarButton>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <EditorContent
        editor={editor}
        style={{ minHeight, padding: '12px 16px' }}
      />
      <style>{`
        .tiptap {
          outline: none;
          color: var(--foreground);
          font-size: 15px;
          line-height: 1.8;
        }
        .tiptap p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--muted);
          pointer-events: none;
          height: 0;
        }
        .tiptap h2 { font-size: 20px; font-weight: 700; margin: 20px 0 8px; letter-spacing: -0.02em; }
        .tiptap h3 { font-size: 17px; font-weight: 600; margin: 16px 0 6px; letter-spacing: -0.01em; }
        .tiptap p { margin: 0 0 8px; }
        .tiptap ul, .tiptap ol { padding-left: 20px; margin: 8px 0; }
        .tiptap li { margin: 2px 0; }
        .tiptap blockquote { border-left: 3px solid var(--accent); padding-left: 16px; margin: 12px 0; color: var(--muted); font-style: italic; }
        .tiptap pre { background: #0a0a0a; border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 12px 0; }
        .tiptap code { background: rgba(59,130,246,0.1); padding: 2px 5px; border-radius: 3px; font-family: monospace; font-size: 13px; }
        .tiptap pre code { background: none; padding: 0; }
        .tiptap img { max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; }
        .tiptap a { color: var(--accent); text-decoration: underline; }
        .tiptap hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
      `}</style>
    </div>
  );
}
