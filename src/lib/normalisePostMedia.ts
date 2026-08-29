/**
 * What a post is allowed to carry as attachments, decided in ONE place.
 *
 * Creating a post and editing one held two near-identical copies of this — the
 * edit route's comment literally said "Normalise the same way the POST route
 * does", which is the shape of a rule that will drift. Adding the authors'
 * picture descriptions would have meant writing every check twice, so the copy
 * is gone instead.
 *
 * Pure: takes whatever arrived on the wire, returns either the value to store
 * or a message to send back. No database, no network, no request object — so
 * every branch below is reachable from a test.
 */

export const MAX_IMAGES = 10;
export const MAX_VIDEOS = 3;

/**
 * How long a picture's description may be.
 *
 * Long enough for a real sentence about a photograph, short enough that it
 * cannot be used to smuggle a document into a field nobody reads. A screen
 * reader announces the whole thing in one breath, so length here is a courtesy
 * to the person listening as much as a limit on the person typing.
 */
export const MAX_IMAGE_ALT = 300;

export interface StoredMedia {
  images?: string[];
  videos?: string[];
  /** A picture's URL to the author's description of it. */
  imageAlts?: Record<string, string>;
}

export type MediaResult =
  | { ok: true; media: StoredMedia | null }
  | { ok: false; error: string };

/** Our own uploads are root-relative; anything else must be a web address. */
const ALLOWED_IMAGE_URL = /^(https?:\/\/|\/api\/media\/)/i;

export function normalisePostMedia(
  input: unknown,
  isSupportedVideoUrl: (url: string) => boolean,
): MediaResult {
  if (!input || typeof input !== 'object') return { ok: true, media: null };
  const raw = input as Record<string, unknown>;

  const images = Array.isArray(raw.images)
    ? (raw.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  const videos = Array.isArray(raw.videos)
    ? (raw.videos as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  if (images.length > MAX_IMAGES) return { ok: false, error: `Too many images (max ${MAX_IMAGES})` };
  if (videos.length > MAX_VIDEOS) return { ok: false, error: `Too many videos (max ${MAX_VIDEOS})` };

  /*
   * `POST /api/upload` returns `/api/media/...`, not an absolute R2 address
   * (see docs/design/media-bucket-privatisation.md). This check was once
   * `^https?://`-only and rejected every real upload with a 400 — nothing in
   * the route hinted the check existed, so only an end-to-end run against a
   * live environment found it.
   */
  const badImage = images.find((u) => !ALLOWED_IMAGE_URL.test(u));
  if (badImage) return { ok: false, error: `Invalid image URL: ${badImage}` };

  const badVideo = videos.find((u) => !isSupportedVideoUrl(u));
  if (badVideo) {
    return { ok: false, error: `Unsupported video URL (YouTube or Vimeo only): ${badVideo}` };
  }

  const altResult = normaliseImageAlts(raw.imageAlts, images);
  if (!altResult.ok) return altResult;
  const imageAlts = altResult.value;

  if (images.length === 0 && videos.length === 0) return { ok: true, media: null };

  return {
    ok: true,
    media: {
      ...(images.length > 0 ? { images } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      ...(Object.keys(imageAlts).length > 0 ? { imageAlts } : {}),
    },
  };
}

type AltResult = { ok: true; value: Record<string, string> } | { ok: false; error: string };

/**
 * The authors' descriptions, keyed by the picture each one is about.
 *
 * THREE RULES, each protecting something different:
 *
 *   a key that is not in `images` is DROPPED, not an error. Removing a picture
 *     from a post and forgetting to remove its description is the client being
 *     ordinary, not the client being wrong — and keeping the orphan would leave
 *     a description that reattaches if the same picture is added back later.
 *
 *   an EMPTY description is KEPT, because empty means something: the author
 *     looked at the picture and said it carries nothing a reader needs. That is
 *     a different answer from never having been asked, and the galleries act on
 *     the difference.
 *
 *   too long is an ERROR, not a silent trim. A description cut off mid-sentence
 *     is worse than being told to shorten it, and silently storing 300 of the
 *     900 characters someone wrote is a lie about what was saved.
 */
function normaliseImageAlts(raw: unknown, images: string[]): AltResult {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'imageAlts must be an object mapping image URLs to descriptions' };
  }

  const known = new Set(images);
  const out: Record<string, string> = {};

  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(url)) continue;
    if (typeof value !== 'string') {
      return { ok: false, error: `Description for ${url} must be text` };
    }
    // Leading and trailing space is never meaningful in a description, and
    // whitespace-only is the same statement as empty: nothing to announce.
    const text = value.trim();
    if (text.length > MAX_IMAGE_ALT) {
      return {
        ok: false,
        error: `Description is too long (max ${MAX_IMAGE_ALT} characters, got ${text.length})`,
      };
    }
    out[url] = text;
  }

  return { ok: true, value: out };
}
