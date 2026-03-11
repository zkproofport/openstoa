'use client';

import React, { useRef, useState, useEffect } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Embed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSContentProps {
  html: string;
  media?: { embeds?: Embed[] } | null;
  truncate?: boolean;
  maxLines?: number;
  onToggleExpand?: () => void;
}

// ─── URL Auto-linking in HTML ───────────────────────────────────────────────

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

/**
 * Auto-link plain-text URLs in HTML content.
 * Only processes text nodes (not inside existing <a> tags or attributes).
 */
function autoLinkUrls(html: string): string {
  // Simple approach: split by existing tags, linkify text segments only
  const parts = html.split(/(<[^>]*>)/);
  let insideAnchor = false;

  return parts.map(part => {
    if (part.startsWith('<')) {
      const lower = part.toLowerCase();
      if (lower.startsWith('<a ') || lower.startsWith('<a>')) insideAnchor = true;
      if (lower.startsWith('</a')) insideAnchor = false;
      return part;
    }
    if (insideAnchor) return part;
    return part.replace(URL_REGEX, (url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(59,130,246,0.4);word-break:break-all;">${url}</a>`
    );
  }).join('');
}

// ─── Video Embeds ───────────────────────────────────────────────────────────

function VideoEmbeds({ embeds }: { embeds: Embed[] }) {
  if (embeds.length === 0) return null;

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {embeds.map((embed) => {
        const src = embed.type === 'youtube'
          ? `https://www.youtube.com/embed/${embed.videoId}`
          : `https://player.vimeo.com/video/${embed.videoId}`;

        return (
          <div
            key={embed.videoId}
            style={{
              position: 'relative',
              width: '100%',
              paddingBottom: '56.25%',
              borderRadius: 10,
              overflow: 'hidden',
              background: '#0a0a0a',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <iframe
              src={src}
              title={`${embed.type} video`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                border: 'none',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SNSContent({ html, media, truncate, maxLines = 4, onToggleExpand }: SNSContentProps) {
  const embeds = media?.embeds ?? [];
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const linkedHtml = autoLinkUrls(html);

  useEffect(() => {
    if (truncate && contentRef.current) {
      const el = contentRef.current;
      setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
    }
  }, [truncate, html]);

  return (
    <div style={{
      fontSize: 15,
      lineHeight: 1.8,
      color: 'var(--foreground)',
      wordBreak: 'break-word',
      fontFamily: "-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
    }}>
      {/* HTML content */}
      <div
        ref={contentRef}
        dangerouslySetInnerHTML={{ __html: linkedHtml }}
        style={{
          ...(truncate ? {
            display: '-webkit-box',
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: 'vertical' as const,
            overflow: 'hidden',
          } : {}),
        }}
      />

      {/* "more" link for truncated content */}
      {truncate && isOverflowing && onToggleExpand && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(); }}
          style={{
            background: 'none',
            border: 'none',
            color: '#6b7280',
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
            marginTop: 2,
          }}
        >
          more
        </button>
      )}

      {/* Video embeds (hidden in truncated mode) */}
      {!truncate && <VideoEmbeds embeds={embeds} />}

      <style>{`
        [dangerouslysetinnerhtml] img,
        div > img {
          max-width: 100%;
          height: auto;
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}
