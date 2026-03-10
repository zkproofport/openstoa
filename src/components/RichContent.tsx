'use client';

interface RichContentProps {
  html: string;
}

export default function RichContent({ html }: RichContentProps) {
  return (
    <>
      <div
        className="tiptap-content"
        dangerouslySetInnerHTML={{ __html: html }}
        style={{
          fontSize: 15,
          lineHeight: 1.8,
          color: 'var(--foreground)',
          wordBreak: 'break-word',
        }}
      />
      <style>{`
        .tiptap-content h2 { font-size: 20px; font-weight: 700; margin: 20px 0 8px; letter-spacing: -0.02em; }
        .tiptap-content h3 { font-size: 17px; font-weight: 600; margin: 16px 0 6px; }
        .tiptap-content p { margin: 0 0 8px; }
        .tiptap-content ul, .tiptap-content ol { padding-left: 20px; margin: 8px 0; }
        .tiptap-content li { margin: 2px 0; }
        .tiptap-content blockquote { border-left: 3px solid var(--accent); padding-left: 16px; margin: 12px 0; color: var(--muted); font-style: italic; }
        .tiptap-content pre { background: #0a0a0a; border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; overflow-x: auto; margin: 12px 0; }
        .tiptap-content code { background: rgba(59,130,246,0.1); padding: 2px 5px; border-radius: 3px; font-family: monospace; font-size: 13px; }
        .tiptap-content pre code { background: none; padding: 0; }
        .tiptap-content img { max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; }
        .tiptap-content a { color: var(--accent); text-decoration: underline; }
        .tiptap-content hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
      `}</style>
    </>
  );
}
