/**
 * What "copy" puts on the clipboard, for BOTH clients.
 *
 * Copy means the message AS SENT. Not the preview's title, not its description,
 * not the canonical or redirect-resolved form of the link — those are metadata
 * this client derived, and the person copying is asking for what was written.
 * The query string and fragment are part of that: a link to a timestamp or an
 * anchor stops meaning the same thing without them.
 *
 * Two copies exist — `src/lib/messageActions.ts` (web) and
 * `packages/mobile/src/lib/messageActions.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/**
 * URLs in a message body, in the order they appear.
 *
 * Deliberately narrow: http(s) only. A `mailto:` or a bare `www.` is not
 * something "copy link" can hand to a browser unambiguously, and guessing a
 * scheme would put a URL on the clipboard that the sender never wrote.
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Trailing characters that end a SENTENCE rather than a URL. */
const TRAILING = /[.,;:!?"']+$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Trim what the prose put after the link, and nothing the link needs.
 *
 * The two cases pull opposite ways: `(see https://example.com/a)` ends with a
 * bracket belonging to the sentence, while
 * `https://en.wikipedia.org/wiki/Foo_(bar)` ends with one belonging to the
 * path. Counting decides it — a closer is the sentence's only if the URL has
 * no opener to match it.
 */
function trimTrailing(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(TRAILING, '');
    const last = trimmed[trimmed.length - 1];
    const opener = last ? CLOSERS[last] : undefined;
    if (opener) {
      const opens = trimmed.split(opener).length - 1;
      const closes = trimmed.split(last).length - 1;
      if (closes > opens) {
        url = trimmed.slice(0, -1);
        continue;
      }
    }
    return trimmed;
  }
}

export function extractUrls(body: string): string[] {
  URL_RE.lastIndex = 0;
  const out: string[] = [];
  for (const m of body.matchAll(URL_RE)) {
    const url = trimTrailing(m[0]);
    if (url.length > 0 && !out.includes(url)) out.push(url);
  }
  return out;
}

export interface CopyTargets {
  /** The message exactly as sent. Always offered. */
  message: string;
  /**
   * The single link in the message, when there is exactly one.
   *
   * Null for none — nothing to copy — and null for several, because picking one
   * would be a silent guess about which the reader meant. With several, the
   * whole message is the honest answer and "copy message" already gives it.
   */
  link: string | null;
}

export function copyTargets(body: string): CopyTargets {
  const urls = extractUrls(body);
  return { message: body, link: urls.length === 1 ? urls[0] : null };
}
