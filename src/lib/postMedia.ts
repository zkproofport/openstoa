// Shared post-media extraction. PostCard list rows AND the post detail
// page both call this so a YouTube link pasted into a legacy post body
// still surfaces in the swipeable MediaGallery instead of vanishing
// when SNSContent's inline rendering is bypassed.

export interface PostMediaSource {
  content: string;
  media?: { images?: string[]; videos?: string[] } | null;
}

export function collectPostMedia(post: PostMediaSource): {
  images: string[];
  videos: string[];
} {
  const images: string[] = [];
  const videos: string[] = [];
  const seen = new Set<string>();
  const pushImg = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    images.push(url);
  };
  const pushVid = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    videos.push(url);
  };

  for (const url of post.media?.images ?? []) pushImg(url);
  for (const url of post.media?.videos ?? []) pushVid(url);

  // Inline <img> tags in legacy HTML bodies.
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(post.content)) !== null) pushImg(m[1]);

  // YouTube and Vimeo URLs in the body — covers posts created before the
  // unified composer pushed video URLs into `media.videos`.
  const ytRegex = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}\S*/gi;
  while ((m = ytRegex.exec(post.content)) !== null) pushVid(m[0]);

  const vimeoRegex = /https?:\/\/(?:www\.)?vimeo\.com\/\d+\S*/gi;
  while ((m = vimeoRegex.exec(post.content)) !== null) pushVid(m[0]);

  return { images, videos };
}

// Removes YouTube/Vimeo URLs (and the <a> tags wrapping them) from a post
// body so the renderer doesn't show the raw URL above the swipeable
// MediaGallery embed. Mirror of the mobile `stripVideoUrls` helper.
//
// R05 fix: short-circuit when the body contains no video URL at all. The
// previous unconditional `\n\s*\n -> \n` pass collapsed multi-line plain
// text into a single line, so a post that just had blank lines between
// paragraphs rendered as one squashed block. Now the newline-collapsing
// pass only runs when we actually removed a video URL, which is the only
// case where empty paragraphs would otherwise be left behind.
export function stripVideoUrls(html: string): string {
  if (!html) return '';
  const VIDEO_DETECT = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/|vimeo\.com\/\d+)/i;
  if (!VIDEO_DETECT.test(html)) return html;
  return html
    .replace(/<a[^>]+href=["'][^"']*(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|vimeo\.com\/\d+)[^"']*["'][^>]*>[^<]*<\/a>/gi, '')
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/(?:www\.)?vimeo\.com\/\d+[^\s<]*/gi, '')
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '');
  // Note: do NOT collapse \n\s*\n -> \n here. Empty paragraphs from removed
  // video URLs are handled by the empty-<p> replacement above; plain-text
  // \n runs are part of the user's intentional layout and MUST be preserved
  // for SNSContent's plainTextChunks split + whiteSpace:pre-wrap to render
  // correctly (regression #R05 was caused by this collapse).
}
