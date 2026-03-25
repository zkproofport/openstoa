'use client';

import React, { useRef, useState, useEffect, useMemo } from 'react';
import LinkPreview from './LinkPreview';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VideoEmbed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSContentProps {
  html: string;
  truncate?: boolean;
  maxLines?: number;
  onToggleExpand?: () => void;
  onOverflowChange?: (isOverflowing: boolean) => void;
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

// ─── Video URL Detection & Extraction ────────────────────────────────────────

const VIDEO_PATTERNS = [
  // YouTube: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID
  { type: 'youtube' as const, regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?[^\s<]*v=([a-zA-Z0-9_-]{11})[^\s<]*/g },
  { type: 'youtube' as const, regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})[^\s<]*/g },
  { type: 'youtube' as const, regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})[^\s<]*/g },
  // Vimeo: vimeo.com/ID
  { type: 'vimeo' as const, regex: /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)[^\s<]*/g },
];

function isVideoUrl(url: string): boolean {
  return VIDEO_PATTERNS.some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(url);
  });
}

function extractVideoUrls(html: string): { videoEmbeds: VideoEmbed[]; cleanedHtml: string } {
  const videoEmbeds: VideoEmbed[] = [];
  const seenIds = new Set<string>();
  let cleanedHtml = html;

  // Helper to collect a video embed (deduplicating by videoId)
  function collect(type: VideoEmbed['type'], videoId: string, matchedUrl: string) {
    if (seenIds.has(videoId)) return;
    seenIds.add(videoId);
    videoEmbeds.push({ type, videoId, url: matchedUrl });
  }

  // 1. Extract video URLs from <a> href attributes and remove the entire <a> tag
  const anchorPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
  cleanedHtml = cleanedHtml.replace(anchorPattern, (match, href) => {
    for (const { type, regex } of VIDEO_PATTERNS) {
      regex.lastIndex = 0;
      const m = regex.exec(href);
      if (m) {
        collect(type, m[1], href);
        return '';
      }
    }
    return match;
  });

  // 2. Extract plain-text video URLs (not inside tags)
  const parts = cleanedHtml.split(/(<[^>]*>)/);
  let insideAnchor = false;
  const processedParts = parts.map(part => {
    if (part.startsWith('<')) {
      const lower = part.toLowerCase();
      if (lower.startsWith('<a ') || lower.startsWith('<a>')) insideAnchor = true;
      if (lower.startsWith('</a')) insideAnchor = false;
      return part;
    }
    if (insideAnchor) return part;

    let processed = part;
    for (const { type, regex } of VIDEO_PATTERNS) {
      regex.lastIndex = 0;
      processed = processed.replace(regex, (url, videoId) => {
        collect(type, videoId, url);
        return '';
      });
    }
    return processed;
  });
  cleanedHtml = processedParts.join('');

  return { videoEmbeds, cleanedHtml };
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

function VideoEmbeds({ embeds }: { embeds: VideoEmbed[] }) {
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
  truncate,
  maxLines = 4,
  onToggleExpand,
  onOverflowChange,
}: SNSContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // 1. Extract video URLs from HTML
  const { videoEmbeds, cleanedHtml: htmlAfterVideos } = useMemo(() => extractVideoUrls(html), [html]);

  // 2. Extract GIFs from remaining HTML
  const { gifUrls, cleanedHtml: htmlAfterGifs } = useMemo(() => extractGifs(htmlAfterVideos), [htmlAfterVideos]);

  // 3. Auto-link remaining URLs
  const linkedHtml = useMemo(() => autoLinkUrls(htmlAfterGifs), [htmlAfterGifs]);

  // First URL in content for link preview (only in non-truncated mode)
  const firstUrl = useMemo(() => {
    if (truncate) return null;
    return extractFirstUrl(html);
  }, [html, truncate]);

  // Filter out GIF and video URLs from link preview
  const previewUrl = useMemo(() => {
    if (!firstUrl) return null;
    if (isGifUrl(firstUrl)) return null;
    if (isVideoUrl(firstUrl)) return null;
    return firstUrl;
  }, [firstUrl]);

  useEffect(() => {
    if (truncate && contentRef.current) {
      const el = contentRef.current;
      const overflowing = el.scrollHeight > 200 + 2;
      setIsOverflowing(overflowing);
      onOverflowChange?.(overflowing);
    }
  }, [truncate, html, onOverflowChange]);

  return (
    <div style={{
      fontSize: 15,
      lineHeight: 1.8,
      color: 'var(--foreground)',
      wordBreak: 'break-word',
      fontFamily: "-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
    }}>
      {/* HTML content */}
      {truncate ? (
        <div style={{ position: 'relative' }}>
          <div
            ref={contentRef}
            className="sns-content-body"
            dangerouslySetInnerHTML={{ __html: linkedHtml }}
            style={{
              maxHeight: 200,
              overflow: 'hidden',
            }}
          />
          {isOverflowing && (
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 60,
              background: 'linear-gradient(transparent, #0a0a0a)',
              pointerEvents: 'none',
            }} />
          )}
        </div>
      ) : (
        <div
          className="sns-content-body"
          dangerouslySetInnerHTML={{ __html: linkedHtml }}
        />
      )}

      {/* "Show more" button for truncated content */}
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
            marginTop: 6,
            letterSpacing: '-0.01em',
          }}
        >
          Show more
        </button>
      )}

      {/* GIFs only in full mode — in truncate mode, PostCard gallery handles preview */}
      {!truncate && gifUrls.length > 0 && (
        <GifImages urls={gifUrls} />
      )}

      {/* Link preview and video embeds only in full mode */}
      {!truncate && (
        <>
          {previewUrl && gifUrls.length === 0 && (
            <LinkPreview url={previewUrl} />
          )}
          <VideoEmbeds embeds={videoEmbeds} />
        </>
      )}

      <style>{`
        .sns-content-body img {
          max-width: 100%;
          max-height: 400px;
          height: auto;
          object-fit: contain;
          border-radius: 8px;
          display: block;
          margin-left: 0;
          margin-right: auto;
        }
        @media (max-width: 640px) {
          .sns-content-body img {
            max-height: 280px;
          }
        }
      `}</style>
    </div>
  );
}
