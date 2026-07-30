'use client';

import React, { useRef, useState, useEffect, useMemo } from 'react';
import LinkPreview from './LinkPreview';
import { useTranslation } from '@/lib/i18n/I18nProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VideoEmbed {
  type: 'youtube' | 'vimeo';
  url: string;
  videoId: string;
}

interface SNSContentProps {
  /** Post body. May be legacy HTML (contains `<` tags, `<img>`, `<a>`) or
   *  plain text from the unified composer. Plain text is rendered as-is
   *  with newlines preserved; HTML is sanitised/auto-linked as before. */
  html: string;
  /** Phase A2: explicit media attached to the post (separate from `html`).
   *  Rendered as a gallery in addition to anything still embedded in legacy
   *  HTML content. */
  mediaImages?: string[];
  mediaVideos?: string[];
  truncate?: boolean;
  maxLines?: number;
  onToggleExpand?: () => void;
  onOverflowChange?: (isOverflowing: boolean) => void;
  /**
   * Strips `<img>` tags FROM THE BODY HTML only. Has NO effect on
   * `mediaImages` (Photo button uploads) which are rendered separately by
   * MediaGallery / MediaImages. Animated GIFs are also preserved — they
   * have a dedicated GifImages renderer.
   *
   * Use case: collapsed feed card where the first image is shown above
   * the text preview by the parent (PostCard) and the body would
   * otherwise render the same image inline a second time.
   *
   * Invariants:
   *   1. stripInlineImages only mutates the HTML string passed via `html`.
   *      It never reads or filters `mediaImages` / `mediaVideos`.
   *   2. GIFs in the body are preserved regardless of this flag because
   *      they are rendered by the inline GifImages component, not the
   *      MediaGallery.
   *
   * Defaults to false so comments and any other surface that genuinely
   * embeds images inline keep working. (W05)
   */
  stripInlineImages?: boolean;
  /**
   * When true and `truncate` is also true, the inline OG card (LinkPreview)
   * is rendered inside the clipped body so the user sees the card preview
   * in the collapsed feed card. The whole body+card stack is wrapped in
   * the 200px maxHeight clip; clicking Show more removes the clip and
   * reveals everything. Defaults to false to preserve the pre-I10 behaviour
   * where the truncated body did not include the OG card. (I10)
   */
  inlineOgOnTruncate?: boolean;
}

// Treat as HTML if it contains any tag-like sequence; otherwise plain text.
function looksLikeHtml(s: string): boolean {
  return /<[a-zA-Z!\/][^>]*>/.test(s);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Convert plain text to HTML preserving newlines, then auto-link URLs upstream.
function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// R07: render a plain-text chunk into React nodes, auto-linking any URLs
// inline. The plain-text branch previously rendered `chunk.text` raw so
// URLs inside the body of a post were visible but not clickable. We split
// each chunk on URL boundaries and emit an <a target="_blank"> for every
// match so the click opens the link instead of being ignored or, when the
// body sits inside a parent <Link> (PostCard feed row), being swallowed
// by the post-detail navigation.
function renderTextWithLinks(text: string): React.ReactNode {
  if (!text) return text;
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // role="link" <span> instead of <a> so PostCard's outer <Link>
      // wrapper doesn't produce nested anchors — invalid HTML the browser
      // unwraps client-side, which causes React #418 hydration mismatch
      // (the recurring "Minified React error #418" infinite postMessage
      // loop reported by the user). Keyboard accessibility preserved.
      return (
        <span
          key={i}
          role="link"
          tabIndex={0}
          className="os-break-all"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(part, '_blank', 'noopener,noreferrer');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              window.open(part, '_blank', 'noopener,noreferrer');
            }
          }}
          style={{
            color: 'var(--accent)',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            textDecorationColor: 'rgba(59,130,246,0.4)',
            cursor: 'pointer',
          }}
        >
          {part}
        </span>
      );
    }
    return part;
  });
}

// ─── Video URL parsing for the explicit `mediaVideos` array ─────────────────

function parseVideoUrl(url: string): VideoEmbed | null {
  for (const { type, regex } of VIDEO_PATTERNS) {
    regex.lastIndex = 0;
    const m = regex.exec(url);
    if (m) return { type, videoId: m[1], url };
  }
  return null;
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
    // Emit <span data-href> instead of <a> — PostCard wraps the card body in
    // a Next.js <Link> (rendered as <a>), and nested anchors are invalid
    // HTML that browsers unwrap client-side, causing React #418 hydration
    // mismatch and an infinite postMessage retry loop. SNSContent's useEffect
    // delegates click on .sns-url-link to window.open for the same UX.
    return part.replace(URL_REGEX, (url) => {
      const safe = url.replace(/"/g, '&quot;');
      return `<span class="sns-url-link os-break-all" data-href="${safe}" role="link" tabindex="0" style="color:var(--accent);text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(59,130,246,0.4);cursor:pointer;">${url}</span>`;
    });
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

// ─── Inline <img> stripping (W05) ───────────────────────────────────────────
// The post detail page renders text body via SNSContent AND images via the
// shared MediaGallery (`collectPostMedia` scrapes inline `<img>` tags and
// merges them with `media.images`). Without this strip the same image
// would render twice — once via `dangerouslySetInnerHTML` here, once in
// the carousel — and on web the inline copy frequently shows as a broken
// icon because the surrounding paragraph wrapper, CSS layout, and missing
// onerror handling don't match what the lightbox path provides.
//
// Two safe assumptions:
//   1. The MediaGallery is the single source of truth for visual images.
//      Whatever <img> appears in `content` is already picked up by
//      `collectPostMedia` and shown there.
//   2. Animated GIFs are intentionally a separate path (we still want
//      them inline-ish via the GifImages renderer below) — we strip
//      those URLs from the gallery side, so non-GIF strips here.
//
// Invariants (verified):
//   - Only the `html` argument (body HTML) is mutated. The caller's
//     `media.images` / `mediaImages` array is NEVER inspected here.
//   - Animated GIF `<img>` tags pass through unchanged so the GifImages
//     renderer below can still show them.
//   - Non-`<img>` tags (links, text, <br>, <p>) are untouched.
function stripNonGifImgTags(html: string): string {
  if (!html) return '';
  return html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>\s*/gi, (match, src) => {
    return isGifUrl(src) ? match : '';
  });
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

// Gallery for explicit `mediaImages` from the unified composer. Matches the
// mobile PostDetailScreen feel: full-width tiles stacked vertically, clickable
// via the same delegated image handler on the parent page.
function MediaImages({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="sns-content-body" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {urls.map((url, i) => (
        <img
          key={`${url}-${i}`}
          src={url}
          alt=""
          style={{
            width: '100%',
            maxHeight: 480,
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
  mediaImages,
  mediaVideos,
  truncate,
  maxLines = 4,
  onToggleExpand,
  onOverflowChange,
  stripInlineImages = false,
  inlineOgOnTruncate = false,
}: SNSContentProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // I01: Detect plain-text vs legacy HTML up front. Plain text is rendered
  // via JSX with whiteSpace:pre-wrap so consecutive `\n` produce visible
  // blank rows. Legacy HTML keeps the auto-link + extract pipeline below.
  const isPlainText = useMemo(() => !!html && !looksLikeHtml(html), [html]);

  // Plain-text body with video URLs stripped. Mirrors the body-cleanup
  // that extractVideoUrls applies to the HTML branch so YouTube/Vimeo
  // links that are surfaced as iframes don't ALSO appear as bare text.
  const plainBody = useMemo(() => {
    if (!isPlainText) return html ?? '';
    let s = html ?? '';
    for (const { regex } of VIDEO_PATTERNS) {
      regex.lastIndex = 0;
      s = s.replace(regex, '');
    }
    return s;
  }, [html, isPlainText]);

  // Plain text from the unified composer is escaped + <br>'d. Legacy HTML
  // posts go through the existing extraction pipeline unchanged.
  const normalisedHtml = useMemo(() => {
    if (!html) return '';
    return looksLikeHtml(html) ? html : plainTextToHtml(html);
  }, [html]);

  // 1. Extract video URLs from HTML (legacy posts only — new posts keep video
  //    URLs in `mediaVideos` so the renderer can show them without parsing).
  const { videoEmbeds, cleanedHtml: htmlAfterVideos } = useMemo(
    () => extractVideoUrls(normalisedHtml),
    [normalisedHtml],
  );

  // 2. Extract GIFs from remaining HTML
  const { gifUrls, cleanedHtml: htmlAfterGifs } = useMemo(() => extractGifs(htmlAfterVideos), [htmlAfterVideos]);

  // 2a. (W05) Strip non-GIF inline <img> tags when the caller opts in.
  //     PostCard feed + PostDetail render a separate MediaGallery (which
  //     scrapes the same `<img>` tags via `collectPostMedia` on the
  //     parent), so leaving them in the body produces a duplicate AND on
  //     web the inline copy frequently renders as a broken icon.
  //     Comments and any other surface that genuinely embeds images
  //     inline keep them by passing stripInlineImages=false (the default).
  //     Animated GIFs are kept either way — they have a dedicated
  //     GifImages renderer below.
  const htmlAfterImgs = useMemo(
    () => (stripInlineImages ? stripNonGifImgTags(htmlAfterGifs) : htmlAfterGifs),
    [htmlAfterGifs, stripInlineImages],
  );

  // 3. Auto-link remaining URLs
  const linkedHtml = useMemo(() => autoLinkUrls(htmlAfterImgs), [htmlAfterImgs]);

  // Combine explicit + legacy media for the gallery render.
  const galleryImages = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of mediaImages ?? []) {
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
  }, [mediaImages]);

  const galleryVideos = useMemo<VideoEmbed[]>(() => {
    const seen = new Set<string>(videoEmbeds.map((v) => v.videoId));
    const out: VideoEmbed[] = [...videoEmbeds];
    for (const url of mediaVideos ?? []) {
      const parsed = parseVideoUrl(url);
      if (parsed && !seen.has(parsed.videoId)) {
        seen.add(parsed.videoId);
        out.push(parsed);
      }
    }
    return out;
  }, [videoEmbeds, mediaVideos]);

  // First URL in content for link preview. In truncate mode we still
  // compute it when `inlineOgOnTruncate` is set (I10) so the collapsed
  // feed card can show the OG card inside the 200px clip.
  const firstUrl = useMemo(() => {
    if (truncate && !inlineOgOnTruncate) return null;
    return extractFirstUrl(html);
  }, [html, truncate, inlineOgOnTruncate]);

  // Filter out GIF and video URLs from link preview
  const previewUrl = useMemo(() => {
    if (!firstUrl) return null;
    if (isGifUrl(firstUrl)) return null;
    if (isVideoUrl(firstUrl)) return null;
    return firstUrl;
  }, [firstUrl]);

  // ── Inline OG split (W04) ────────────────────────────────────────────────
  // Twitter/X-style: the OG card should appear immediately under the
  // paragraph containing the link, not pushed to the very bottom of the
  // post body. We split `linkedHtml` by paragraph breaks (`<br><br>`
  // sequences), find the first paragraph that holds the preview URL, and
  // emit the LinkPreview right after it. Paragraphs before and after are
  // rendered as their own `<div>` blocks so the visual break matches
  // what the single `<br><br>` join produced.
  //
  // Legacy posts that still arrive as raw `<p>...</p>` HTML fall through
  // this split untouched — they end up as one big chunk and we still
  // render the LinkPreview below the body the same way as before.
  const bodyChunks = useMemo<
    Array<{ kind: 'html'; html: string } | { kind: 'preview' }>
  >(() => {
    // Truncated mode skips chunking UNLESS the caller opted into
    // inline OG within the clipped body (I10).
    if ((truncate && !inlineOgOnTruncate) || !previewUrl) {
      return [{ kind: 'html', html: linkedHtml }];
    }
    // Split paragraphs on 2+ consecutive <br> tags (with optional whitespace).
    const PARAGRAPH_SPLIT = /(?:<br\s*\/?>\s*){2,}/i;
    const paragraphs = linkedHtml.split(PARAGRAPH_SPLIT);
    if (paragraphs.length <= 1) {
      // No paragraph breaks → fall back to the pre-W04 layout where the
      // preview sits below the body (handled by the post-body render
      // path). Return the body unchanged here and let the existing
      // post-body LinkPreview render below.
      return [{ kind: 'html', html: linkedHtml }];
    }
    // Locate the first paragraph that contains the preview URL — either
    // as a literal substring (autoLinkUrls leaves the URL text in place
    // inside the <a>) or in an href attribute.
    const previewUrlLower = previewUrl.toLowerCase();
    const targetIdx = paragraphs.findIndex((p) =>
      p.toLowerCase().includes(previewUrlLower),
    );
    if (targetIdx < 0) {
      return [{ kind: 'html', html: linkedHtml }];
    }
    const chunks: Array<{ kind: 'html'; html: string } | { kind: 'preview' }> = [];
    paragraphs.forEach((p, i) => {
      chunks.push({ kind: 'html', html: p });
      if (i === targetIdx) chunks.push({ kind: 'preview' });
    });
    return chunks;
  }, [linkedHtml, previewUrl, truncate, inlineOgOnTruncate]);

  // Plain-text equivalent of bodyChunks. Splits the RAW `html` (which is
  // plain text for the plain-text branch) on blank line(s) and inserts the
  // preview marker after the paragraph that owns the URL. Used by both the
  // truncate and the expanded plain-text render paths so the OG card sits
  // immediately under the URL paragraph instead of after the entire body.
  const plainTextChunks = useMemo<
    Array<{ kind: 'text'; text: string } | { kind: 'preview' }>
  >(() => {
    if (!isPlainText || !previewUrl) {
      return [{ kind: 'text', text: plainBody }];
    }
    const paragraphs = plainBody.split(/\n{2,}/);
    if (paragraphs.length <= 1) {
      return [{ kind: 'text', text: plainBody }];
    }
    const idx = paragraphs.findIndex((p) => p.includes(previewUrl));
    if (idx < 0) {
      return [{ kind: 'text', text: plainBody }];
    }
    const chunks: Array<{ kind: 'text'; text: string } | { kind: 'preview' }> = [];
    paragraphs.forEach((p, i) => {
      chunks.push({ kind: 'text', text: p });
      if (i === idx) chunks.push({ kind: 'preview' });
    });
    return chunks;
  }, [plainBody, isPlainText, previewUrl]);

  // True when the inline split successfully placed a LinkPreview in the
  // body. The trailing post-body LinkPreview render path then skips its
  // own copy to avoid double cards. Covers HTML chunks, plain-text chunks,
  // and the truncate + plain-text clipped wrapper.
  const previewRenderedInline = useMemo(
    () =>
      bodyChunks.some((c) => c.kind === 'preview') ||
      plainTextChunks.some((c) => c.kind === 'preview') ||
      (!!truncate && inlineOgOnTruncate && isPlainText && !!previewUrl),
    [bodyChunks, plainTextChunks, truncate, inlineOgOnTruncate, isPlainText, previewUrl],
  );

  // Click delegate for .sns-url-link spans (autoLinkUrls emits these
  // instead of <a> to avoid nested anchors inside PostCard's outer <Link>).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const handler = (e: Event) => {
      const target = (e.target as HTMLElement)?.closest?.('.sns-url-link') as HTMLElement | null;
      if (!target) return;
      const href = target.getAttribute('data-href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    root.addEventListener('click', handler);
    return () => root.removeEventListener('click', handler);
  }, []);

  useEffect(() => {
    if (!truncate || !contentRef.current) return;
    const el = contentRef.current;

    const checkOverflow = () => {
      const overflowing = el.scrollHeight > 200 + 2;
      setIsOverflowing(overflowing);
      onOverflowChange?.(overflowing);
    };

    // Initial check
    checkOverflow();

    // Re-check after images load (they change scrollHeight)
    const imgs = el.querySelectorAll('img');
    imgs.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', checkOverflow, { once: true });
        img.addEventListener('error', checkOverflow, { once: true });
      }
    });

    // ResizeObserver as fallback for any layout shifts
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(checkOverflow);
      ro.observe(el);
    }

    return () => {
      imgs.forEach((img) => {
        img.removeEventListener('load', checkOverflow);
        img.removeEventListener('error', checkOverflow);
      });
      ro?.disconnect();
    };
  }, [truncate, html, onOverflowChange]);

  return (
    <div style={{
      // Post body is the primary long-form prose surface (Korean or
      // English) — bumped from 15 to the 16px prose/input floor.
      fontSize: 'var(--text-body)',
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
            style={{
              maxHeight: 200,
              overflow: 'hidden',
              // I01: plain-text posts preserve consecutive `\n` as visible
              // blank rows. HTML posts ignore this (they use <br>/<p>).
              whiteSpace: isPlainText ? 'pre-wrap' : undefined,
            }}
          >
            {isPlainText ? (
              // I01: render raw text so newlines remain literal — combined
              // with whiteSpace:pre-wrap this yields one visible blank row
              // per consecutive `\n`. When the body has a paragraph break
              // and the OG card should be inlined (I10), use plainTextChunks
              // so the card sits under the URL's paragraph, not at the end.
              inlineOgOnTruncate && plainTextChunks.some((c) => c.kind === 'preview') ? (
                <>
                  {plainTextChunks.map((chunk, i) => {
                    if (chunk.kind === 'preview') {
                      if (!previewUrl) return null;
                      return <LinkPreview key={`og-${i}`} url={previewUrl} />;
                    }
                    return (
                      <div
                        key={`p-${i}`}
                        style={{
                          whiteSpace: 'pre-wrap',
                          marginBottom: i < plainTextChunks.length - 1 ? '0.85em' : 0,
                        }}
                      >
                        {renderTextWithLinks(chunk.text)}
                      </div>
                    );
                  })}
                </>
              ) : (
                <>
                  {renderTextWithLinks(plainBody)}
                  {/* I10: inline OG inside the clipped body when requested. */}
                  {inlineOgOnTruncate && previewUrl && (
                    <LinkPreview url={previewUrl} />
                  )}
                </>
              )
            ) : (
              // Legacy HTML path. When inlineOgOnTruncate is set we emit
              // the same paragraph+preview chunks as the expanded view so
              // the OG card sits inside the 200px clip (I10). Otherwise we
              // render the body as a single HTML blob (pre-I10 behaviour).
              inlineOgOnTruncate && bodyChunks.some((c) => c.kind === 'preview') ? (
                <>
                  {bodyChunks.map((chunk, i) => {
                    if (chunk.kind === 'preview') {
                      if (!previewUrl) return null;
                      return <LinkPreview key={`og-${i}`} url={previewUrl} />;
                    }
                    return (
                      <div
                        key={`p-${i}`}
                        style={{
                          marginBottom: i < bodyChunks.length - 1 ? '0.85em' : 0,
                        }}
                        dangerouslySetInnerHTML={{ __html: chunk.html }}
                      />
                    );
                  })}
                </>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: linkedHtml }} />
              )
            )}
          </div>
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
      ) : isPlainText ? (
        // I01: expanded plain-text path. whiteSpace:pre-wrap turns every
        // `\n` into a visible line break, including consecutive runs.
        // When plainTextChunks split on a URL paragraph, render those
        // chunks with the LinkPreview inline (W04 parity for plain-text
        // posts). Otherwise the trailing LinkPreview block renders the
        // card below the body.
        plainTextChunks.some((c) => c.kind === 'preview') ? (
          <div className="sns-content-body">
            {plainTextChunks.map((chunk, i) => {
              if (chunk.kind === 'preview') {
                if (!previewUrl) return null;
                return <LinkPreview key={`og-${i}`} url={previewUrl} />;
              }
              return (
                <div
                  key={`p-${i}`}
                  style={{
                    whiteSpace: 'pre-wrap',
                    marginBottom: i < plainTextChunks.length - 1 ? '0.85em' : 0,
                  }}
                >
                  {renderTextWithLinks(chunk.text)}
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="sns-content-body"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {renderTextWithLinks(plainBody)}
          </div>
        )
      ) : (
        // W04: inline OG. When `bodyChunks` contains a `preview` marker we
        // emit paragraph <div>s with the LinkPreview right after the
        // paragraph that owns the URL — same as Twitter/X. When there's
        // no preview or no paragraph break to split on, this collapses
        // to a single chunk and renders identically to the pre-W04 path.
        <div className="sns-content-body">
          {bodyChunks.map((chunk, i) => {
            if (chunk.kind === 'preview') {
              if (!previewUrl) return null;
              return <LinkPreview key={`og-${i}`} url={previewUrl} />;
            }
            return (
              <div
                key={`p-${i}`}
                style={{
                  // Mirror the visual gap that two <br><br> produced.
                  marginBottom: i < bodyChunks.length - 1 ? '0.85em' : 0,
                }}
                dangerouslySetInnerHTML={{ __html: chunk.html }}
              />
            );
          })}
        </div>
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
            fontSize: 'var(--text-caption)',
            fontWeight: 500,
            cursor: 'pointer',
            padding: '2px 0',
            marginTop: 6,
            letterSpacing: '-0.01em',
          }}
        >
          {t('content.showMore')}
        </button>
      )}

      {/* Image gallery (new posts) + GIFs (legacy HTML extraction).
          In truncate mode, PostCard handles preview, so we render nothing extra. */}
      {!truncate && galleryImages.length > 0 && (
        <MediaImages urls={galleryImages} />
      )}
      {!truncate && gifUrls.length > 0 && (
        <GifImages urls={gifUrls} />
      )}

      {/* LinkPreview is always shown when there's a URL (mirrors mobile
          PostBodyWithOg behaviour — feed cards get OG cards too, not just
          PostDetail). Video embeds remain full-mode only because expanded
          video iframes don't fit the compact feed-card layout.
          When the inline split (W04) already placed the card after the
          URL's paragraph, we skip the trailing copy so the user sees
          exactly one card. */}
      {previewUrl && !previewRenderedInline && gifUrls.length === 0 && galleryImages.length === 0 && (
        <LinkPreview url={previewUrl} />
      )}
      {!truncate && <VideoEmbeds embeds={galleryVideos} />}

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
