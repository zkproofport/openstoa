import React, { useMemo } from 'react';
import { Linking, Text, useWindowDimensions, View } from 'react-native';
import RenderHtml, { defaultSystemFonts } from 'react-native-render-html';
import { useThemeColors } from '../theme/ThemeContext';

export interface PostContentProps {
  /** HTML-formatted post body. Mirrors the web's `post.content` field which
   *  the dashboard editor produces as sanitized HTML (see web's SNSContent
   *  component which takes `html: string`). Plain text is also fine — HTML
   *  with no tags renders identically. */
  content: string;
  /** When set, the body is clipped to ~maxLines * lineHeight via an outer
   *  `maxHeight` wrapper. The host card decides whether to also show a
   *  "Show more" toggle. */
  maxLines?: number;
  /** When true, strips <img>, <video>, and <iframe> tags from the HTML
   *  before rendering. Use in collapsed card view where the first image is
   *  shown separately below the text preview. */
  omitImages?: boolean;
  /** Override link tap behavior. Defaults to `Linking.openURL`. */
  onPressLink?: (url: string) => void;
}

/** Returns the src of the first <img> found in an HTML string, or null. */
export function extractFirstImage(html: string): string | null {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : null;
}

/** Media item type matching the web PostCard's compact gallery. */
export interface MediaItem {
  type: 'image' | 'youtube' | 'vimeo';
  /** The original source — image URL, YouTube video id, or Vimeo video id. */
  src: string;
  /** Display thumbnail URL (empty string if Vimeo without a known thumb). */
  thumbnail: string;
}

/**
 * Extract images, YouTube and Vimeo references from a post's HTML body in
 * the same order they appear. Mirrors openstoa/src/components/PostCard.tsx
 * (lines 351-377) so the mobile feed thumbnail row matches the web's
 * compact 80×80 strip.
 */
export function extractMediaItems(html: string): MediaItem[] {
  const items: MediaItem[] = [];
  const safe = html || '';

  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let imgM: RegExpExecArray | null;
  while ((imgM = imgRegex.exec(safe)) !== null) {
    items.push({ type: 'image', src: imgM[1], thumbnail: imgM[1] });
  }

  const ytRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/g;
  let ytM: RegExpExecArray | null;
  while ((ytM = ytRegex.exec(safe)) !== null) {
    items.push({
      type: 'youtube',
      src: ytM[1],
      thumbnail: `https://img.youtube.com/vi/${ytM[1]}/mqdefault.jpg`,
    });
  }

  const vimeoRegex = /vimeo\.com\/(\d+)/g;
  let vimeoM: RegExpExecArray | null;
  while ((vimeoM = vimeoRegex.exec(safe)) !== null) {
    items.push({ type: 'vimeo', src: vimeoM[1], thumbnail: '' });
  }

  return items;
}

/**
 * Remove YouTube and Vimeo URL fragments (and any wrapping <a> tags) from
 * the HTML body so they don't render as plain text/links when the caller
 * is also rendering an embed card for the same URL.
 * Mirrors openstoa/src/components/SNSContent.tsx's `extractVideoUrls`
 * behavior — the web cleans the same URLs out of html before passing it
 * to `dangerouslySetInnerHTML`.
 */
export function stripVideoUrls(html: string): string {
  if (!html) return '';
  return html
    // Remove anchor tags wrapping YouTube/Vimeo links
    .replace(/<a[^>]+href=["'][^"']*(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|vimeo\.com\/\d+)[^"']*["'][^>]*>[^<]*<\/a>/gi, '')
    // Remove bare YouTube URLs
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    // Remove bare Vimeo URLs
    .replace(/https?:\/\/(?:www\.)?vimeo\.com\/\d+[^\s<]*/gi, '')
    // Collapse empty <p></p>, <p><br></p> left behind
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '')
    .replace(/\n\s*\n/g, '\n');
}

const SYSTEM_FONTS = [...defaultSystemFonts, 'Menlo'];

// Matches the web's `SNSContent.tsx:352` truncate-mode cap so feed cards
// look identical on web and mobile before "Show more" is tapped.
export const FEED_PREVIEW_MAX_HEIGHT = 200;

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

/**
 * Wrap plain-text URLs in `<a>` tags so they render as tappable links.
 * Mirrors the web's `SNSContent.autoLinkUrls`. URLs that are already
 * inside `<a>` tags are left alone to avoid double-wrapping.
 */
function autoLinkUrls(html: string): string {
  const parts = html.split(/(<[^>]*>)/);
  let insideAnchor = false;
  return parts
    .map((part) => {
      if (part.startsWith('<')) {
        const lower = part.toLowerCase();
        if (lower.startsWith('<a ') || lower.startsWith('<a>')) insideAnchor = true;
        if (lower.startsWith('</a')) insideAnchor = false;
        return part;
      }
      if (insideAnchor) return part;
      return part.replace(URL_REGEX, (url) => `<a href="${url}">${url}</a>`);
    })
    .join('');
}

export function PostContent({ content, maxLines, omitImages, onPressLink }: PostContentProps) {
  const { colors } = useThemeColors();
  const { width } = useWindowDimensions();

  // Plain text path: detect "no HTML tags" and render via native `<Text>`
  // instead of react-native-render-html. This is the only way to keep
  // consecutive newlines visible — RNRH collapses both `<br><br>` and
  // empty `<p>` runs regardless of inline content. Native `<Text>`
  // preserves `\n` exactly as the user typed.
  const isPlainText = useMemo(
    () => !/<[a-zA-Z!\/][^>]*>/.test(content || ''),
    [content],
  );

  const plainSegments = useMemo(() => {
    if (!isPlainText) return null;
    const text = content || '';
    const segs: Array<{ text: string; url?: string }> = [];
    let lastIndex = 0;
    const re = /(https?:\/\/[^\s<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIndex) segs.push({ text: text.slice(lastIndex, m.index) });
      segs.push({ text: m[1], url: m[1] });
      lastIndex = m.index + m[1].length;
    }
    if (lastIndex < text.length) segs.push({ text: text.slice(lastIndex) });
    return segs;
  }, [content, isPlainText]);

  const processedContent = useMemo(() => {
    if (isPlainText) return '';
    let html = content || '';
    if (omitImages) {
      html = html
        .replace(/<(img|video|iframe)\b[^>]*\/?>/gi, '')
        .replace(/<\/(video|iframe)>/gi, '');
    }
    html = autoLinkUrls(html);
    return html;
  }, [content, omitImages, isPlainText]);

  const tagsStyles = useMemo<Record<string, object>>(
    () => ({
      body: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
      p: { marginVertical: 4 },
      a: { color: colors.brand.primary, textDecorationLine: 'underline' },
      img: { maxWidth: '100%', borderRadius: 8, marginVertical: 6 },
      h1: { fontSize: 20, fontWeight: '700', color: colors.text.primary, marginVertical: 6 },
      h2: { fontSize: 17, fontWeight: '700', color: colors.text.primary, marginVertical: 6 },
      h3: { fontSize: 15, fontWeight: '700', color: colors.text.primary, marginVertical: 4 },
      code: {
        backgroundColor: colors.background.tertiary,
        paddingHorizontal: 4,
        borderRadius: 4,
        fontFamily: 'Menlo',
        fontSize: 12,
      },
      pre: {
        backgroundColor: colors.background.tertiary,
        padding: 8,
        borderRadius: 6,
        fontFamily: 'Menlo',
        fontSize: 12,
      },
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: colors.border.strong,
        paddingLeft: 12,
        marginVertical: 4,
        color: colors.text.tertiary,
      },
      ul: { marginVertical: 4 },
      ol: { marginVertical: 4 },
      li: { marginVertical: 2 },
      hr: { backgroundColor: colors.border.default, height: 1, marginVertical: 8 },
    }),
    [colors],
  );

  const baseStyle = useMemo(
    () => ({ color: colors.text.secondary, fontSize: 13, lineHeight: 18 }),
    [colors],
  );

  const renderersProps = useMemo(
    () => ({
      a: {
        onPress: (_e: unknown, href: string) => {
          if (onPressLink) onPressLink(href);
          else void Linking.openURL(href).catch(() => undefined);
        },
      },
    }),
    [onPressLink],
  );

  // `react-native-render-html` issues deprecation warnings about some props
  // we don't pass; silence its noisy defaultProps warnings for cleaner dev
  // logs. (The library still maintains its v6 API.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ignoredDomTags = useMemo(() => ['script', 'style', 'iframe'], []);

  // Plain text path — native <Text> preserves newlines exactly as typed
  // (RNRH collapses both <br><br> and empty <p>&nbsp;</p>). `maxLines` is
  // honored via Text's native `numberOfLines` for consistent line clamping.
  if (isPlainText && plainSegments) {
    return (
      <Text
        style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18 }}
        numberOfLines={maxLines}
        selectable
      >
        {plainSegments.map((seg, i) =>
          seg.url ? (
            <Text
              key={i}
              style={{ color: colors.brand.primary, textDecorationLine: 'underline' }}
              onPress={() => {
                if (onPressLink) onPressLink(seg.url!);
                else void Linking.openURL(seg.url!).catch(() => undefined);
              }}
            >
              {seg.text}
            </Text>
          ) : (
            <Text key={i}>{seg.text}</Text>
          ),
        )}
      </Text>
    );
  }

  // HTML path — legacy posts with real tags (images/iframes/etc).
  const inner = (
    <RenderHtml
      contentWidth={width - 32}
      source={{ html: processedContent }}
      baseStyle={baseStyle}
      tagsStyles={tagsStyles}
      renderersProps={renderersProps}
      systemFonts={SYSTEM_FONTS}
      ignoredDomTags={ignoredDomTags}
      defaultTextProps={{ selectable: true }}
    />
  );

  if (maxLines !== undefined) {
    return (
      <View style={{ maxHeight: FEED_PREVIEW_MAX_HEIGHT, overflow: 'hidden' }}>
        {inner}
      </View>
    );
  }

  return inner;
}
