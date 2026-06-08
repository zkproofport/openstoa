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
// Never collapses runs of \n — the user's intentional blank-line layout
// MUST survive for SNSContent's plainTextChunks paragraph split (which
// requires /\n{2,}/) and whiteSpace:pre-wrap rendering. The empty-<p>
// cleanup below is the only mutation that runs on non-video content;
// it's harmless because legitimate empty <p></p> with no video context
// is rare and visually identical when removed.
export function stripVideoUrls(html: string): string {
  if (!html) return '';
  return html
    .replace(/<a[^>]+href=["'][^"']*(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|vimeo\.com\/\d+)[^"']*["'][^>]*>[^<]*<\/a>/gi, '')
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]{11}[^\s<]*/gi, '')
    .replace(/https?:\/\/(?:www\.)?vimeo\.com\/\d+[^\s<]*/gi, '')
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '');
}
