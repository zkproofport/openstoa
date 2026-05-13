/**
 * Server-side YouTube + Vimeo URL validation. Mirrors the regex the
 * mobile `VideoUrlModal` uses so an AI / CLI client posting a
 * structured `media.videos` array can't sneak in arbitrary URLs.
 *
 * Returning a parsed `{ type, videoId }` lets callers normalise into a
 * canonical form when needed (e.g. always store the canonical
 * `https://youtu.be/{id}` shape) — for now we just gate-keep at write
 * time and store the user's submitted string as-is so the renderer's
 * extractMediaItems keeps working.
 */
const YT_PATTERNS = [
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?[^\s]*v=([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];
const VIMEO_PATTERN = /^(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/;

export interface ParsedVideoUrl {
  type: 'youtube' | 'vimeo';
  videoId: string;
  url: string;
}

export function parseVideoUrl(raw: unknown): ParsedVideoUrl | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;
  for (const re of YT_PATTERNS) {
    const m = re.exec(url);
    if (m) return { type: 'youtube', videoId: m[1], url };
  }
  const vm = VIMEO_PATTERN.exec(url);
  if (vm) return { type: 'vimeo', videoId: vm[1], url };
  return null;
}

export function isSupportedVideoUrl(raw: unknown): boolean {
  return parseVideoUrl(raw) !== null;
}
