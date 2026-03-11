'use client';

import React, { useRef, useState, useEffect, useMemo } from 'react';
import LinkPreview from './LinkPreview';

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

function autoLinkUrls(html: string): string {
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

// ─── Extract first plain URL from HTML ──────────────────────────────────────

function extractFirstUrl(html: string): string | null {
  // Check href attributes first (already linked), then plain text
  const hrefMatch = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1];
  const plainMatch = html.match(URL_REGEX);
  return plainMatch?.[0] ?? null;
}

// ─── GIF Detection & Extraction ─────────────────────────────────────────────

const GIF_DOMAINS = ['giphy.com', 'tenor.com', 'media.giphy.com', 'media.tenor.com'];

function isGifUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (url.toLowerCase().endsWith('.gif')) return true;
    if (GIF_DOMAINS.some(d => parsed.hostname.includes(d))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Extract GIF URLs from HTML content (from <img src>, <a href>, or plain text).
 * Returns the first GIF URL found, and HTML with that GIF's img tag removed
 * (so we don't double-render it).
 */
function extractGifs(html: string): { gifUrls: string[]; cleanedHtml: string } {
  const gifUrls: string[] = [];
  let cleanedHtml = html;

  // Extract GIF img tags and remove them from HTML
  const imgPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  cleanedHtml = cleanedHtml.replace(imgPattern, (match, src) => {
    if (isGifUrl(src)) {
      gifUrls.push(src);
      return '';
    }
    return match;
  });

  // Also check plain-text GIF URLs (not inside tags)
  const parts = cleanedHtml.split(/(<[^>]*>)/);
  let insideAnchor = false;
  const processedParts = parts.map(part => {
    if (part.startsWith('<')) {
      const lower = part.toLowerCase();
      if (lower.startsWith('<a ')) insideAnchor = true;
      if (lower.startsWith('</a')) insideAnchor = false;
      return part;
    }
    if (insideAnchor) return part;
    return part.replace(URL_REGEX, (url) => {
      if (isGifUrl(url)) {
        gifUrls.push(url);
        return '';
      }
      return url;
    });
  });
  cleanedHtml = processedParts.join('');

  // Deduplicate
  const seen = new Set<string>();
  const uniqueGifs = gifUrls.filter(u => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  return { gifUrls: uniqueGifs, cleanedHtml };
}

// ─── GIF Display ────────────────────────────────────────────────────────────

function GifImages({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {urls.map((url, i) => (
        <img
          key={i}
          src={url}
          alt=""
          style={{
            width: '100%',
            maxHeight: 320,
            objectFit: 'contain',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.06)',
            background: '#0a0a0a',
            display: 'block',
          }}
        />
      ))}
    </div>
  );
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

export default function SNSContent({
  html,
  media,
  truncate,
  maxLines = 4,
  onToggleExpand,
}: SNSContentProps) {
  const embeds = media?.embeds ?? [];
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Extract GIFs before auto-linking (so we can clean their img tags)
  const { gifUrls, cleanedHtml } = useMemo(() => extractGifs(html), [html]);

  // Auto-link remaining URLs
  const linkedHtml = useMemo(() => autoLinkUrls(cleanedHtml), [cleanedHtml]);

  // First URL in content for link preview (only in non-truncated mode)
  const firstUrl = useMemo(() => {
    if (truncate) return null;
    return extractFirstUrl(html);
  }, [html, truncate]);

  // Filter out GIF URLs from link preview — don't preview a GIF link
  const previewUrl = useMemo(() => {
    if (!firstUrl) return null;
    if (isGifUrl(firstUrl)) return null;
    // Don't preview YouTube/Vimeo (they're embedded)
    if (/youtube\.com|youtu\.be|vimeo\.com/.test(firstUrl)) return null;
    return firstUrl;
  }, [firstUrl]);

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

      {/* "더보기" button for truncated content */}
      {truncate && isOverflowing && onToggleExpand && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(); }}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            padding: '2px 0',
            marginTop: 2,
            letterSpacing: '-0.01em',
          }}
        >
          더보기
        </button>
      )}

      {/* Rich media (only in expanded/full mode) */}
      {!truncate && (
        <>
          {/* GIFs */}
          <GifImages urls={gifUrls} />

          {/* Link preview — shown only when no image embeds and no GIFs */}
          {previewUrl && gifUrls.length === 0 && (
            <LinkPreview url={previewUrl} />
          )}

          {/* Video embeds */}
          <VideoEmbeds embeds={embeds} />
        </>
      )}

      {/* GIF preview in truncated mode (just the first one, small) */}
      {truncate && gifUrls.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <img
            src={gifUrls[0]}
            alt=""
            style={{
              width: '100%',
              maxHeight: 180,
              objectFit: 'cover',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.06)',
              display: 'block',
            }}
          />
        </div>
      )}

      <style>{`
        div[dangerouslySetInnerHTML] img,
        .sns-content img {
          max-width: 100%;
          height: auto;
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}
