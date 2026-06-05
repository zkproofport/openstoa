import React, { useMemo } from 'react';
import { PostContent } from './PostContent';
import { OGPreviewCard } from './OGPreviewCard';
import { useOgPreview } from '../hooks/useOgPreview';

interface PostBodyWithOgProps {
  /** Already-stripped content (call `stripVideoUrls` upstream). */
  content: string;
  /**
   * Where to send a link tap. Both inline `<a>` taps and the OG card
   * tap go through this so callers route them into the in-app WebView
   * instead of `Linking.openURL` (which kicks the user out to Safari
   * and breaks the back-stack).
   */
  onOpenUrl: (url: string) => void;
  /** Forwarded to PostContent — clip long bodies in feed cards. */
  maxLines?: number;
}

// Detect legacy HTML bodies (anything with a tag). Plain-text bodies are
// split on blank lines (`\n\n`); HTML bodies are split on `<br><br>` or
// `</p>` paragraph breaks. Mirrors the web's SNSContent split logic.
function looksLikeHtml(s: string): boolean {
  return /<[a-zA-Z!\/][^>]*>/.test(s);
}

const PARAGRAPH_SPLIT_HTML = /(?:<br\s*\/?>\s*){2,}|<\/p>\s*<p[^>]*>/i;

/**
 * Split body into [beforeIncludingUrlParagraph, afterUrlParagraph].
 * Returns `null` when no paragraph break is available — caller falls back
 * to "OG below body" so multi-line posts without paragraph breaks still
 * show a card.
 */
function splitAroundUrl(content: string, url: string): { before: string; after: string } | null {
  if (!url) return null;
  const isHtml = looksLikeHtml(content);
  if (isHtml) {
    // Walk paragraph chunks; find the first chunk containing the URL.
    const parts = content.split(PARAGRAPH_SPLIT_HTML);
    if (parts.length <= 1) return null;
    const needle = url.toLowerCase();
    const idx = parts.findIndex((p) => p.toLowerCase().includes(needle));
    if (idx < 0 || idx === parts.length - 1) return null;
    return {
      before: parts.slice(0, idx + 1).join('\n\n'),
      after: parts.slice(idx + 1).join('\n\n'),
    };
  }
  // Plain text: split on blank line(s). Walk paragraphs to find URL.
  const paragraphs = content.split(/\n{2,}/);
  if (paragraphs.length <= 1) return null;
  const idx = paragraphs.findIndex((p) => p.includes(url));
  if (idx < 0 || idx === paragraphs.length - 1) return null;
  return {
    before: paragraphs.slice(0, idx + 1).join('\n\n'),
    after: paragraphs.slice(idx + 1).join('\n\n'),
  };
}

/**
 * Render a post body together with its OpenGraph preview card.
 *
 * Twitter/X-style placement: the OG card appears immediately after the
 * paragraph that owns the URL, not at the very end. When the body has no
 * paragraph break (single block) we fall back to the legacy "OG below
 * body" layout so single-URL posts still get a card.
 *
 * The OG fetch lives in `useOgPreview` and is React Query cached, so
 * the same URL across multiple feed cards only resolves once.
 */
export function PostBodyWithOg({ content, onOpenUrl, maxLines }: PostBodyWithOgProps) {
  const { firstUrl, ogData, hasOG } = useOgPreview(content);

  const split = useMemo(() => {
    if (!firstUrl || !hasOG || !ogData) return null;
    return splitAroundUrl(content, firstUrl);
  }, [content, firstUrl, hasOG, ogData]);

  // No URL / no OG → render body alone.
  if (!firstUrl || !hasOG || !ogData) {
    return <PostContent content={content} onPressLink={onOpenUrl} maxLines={maxLines} />;
  }

  // No paragraph break to split around → legacy layout: body, then card.
  if (!split) {
    return (
      <>
        <PostContent content={content} onPressLink={onOpenUrl} maxLines={maxLines} />
        <OGPreviewCard url={firstUrl} data={ogData} onPress={() => onOpenUrl(firstUrl)} />
      </>
    );
  }

  // Inline placement: before-paragraph(s) → OG card → after-paragraph(s).
  return (
    <>
      <PostContent content={split.before} onPressLink={onOpenUrl} maxLines={maxLines} />
      <OGPreviewCard url={firstUrl} data={ogData} onPress={() => onOpenUrl(firstUrl)} />
      <PostContent content={split.after} onPressLink={onOpenUrl} maxLines={maxLines} />
    </>
  );
}
