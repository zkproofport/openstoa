/**
 * Make a post body safe to hand to `dangerouslySetInnerHTML`.
 *
 * WHAT WAS WRONG. Post content is deliberately HTML — the app embeds
 * `<img src>` after `/api/upload`, so the renderer decides "this looks like
 * markup" and skips escaping. Nothing then asked WHICH markup. Measured in a
 * real browser against a PUBLIC post any visitor can open:
 *
 *   content: <img src=x onerror="document.title='PWNED-ONERROR'">…
 *   document.title  ->  "PWNED-ONERROR"        the handler RAN
 *   img[onerror] 1 · svg[onload] 1 · a[href^=javascript:] 1 · iframe 1
 *
 * Server-rendered HTML was clean (`sanitizeForMeta` strips tags for the meta
 * description), which is exactly why an HTTP-level check said "no payload" —
 * the body is rendered on the client, where fetching the page never looks.
 *
 * REBUILD, DO NOT BLACKLIST. Every tag is dropped unless it is named here, and
 * every attribute is dropped unless it is named for that tag. A blacklist of
 * dangerous things is a list of the attacks someone remembered; this is a list
 * of the markup the product actually emits, and anything else — new HTML
 * features included — is simply not on it.
 */

/** Tags whose CONTENT goes too, not just the tag. */
const DROP_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'form',
  'frameset',
  'frame',
  'applet',
  'canvas',
  'audio',
  'video',
];

/** Tags kept, mapped to the attributes each may carry. Everything else is unwrapped. */
const ALLOWED: Record<string, readonly string[]> = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  br: [],
  p: [],
  div: [],
  span: [],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  del: [],
  code: [],
  pre: [],
  blockquote: [],
  ul: [],
  ol: [],
  li: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  td: [],
  th: [],
};

const VOID_TAGS = new Set(['br', 'img', 'hr']);

/**
 * A URL is safe when it is http(s) or same-document. Whitespace and HTML
 * entities are stripped first: `java&#9;script:` and ` javascript:` both reach
 * the browser as `javascript:`, so comparing the raw string is not enough.
 */
export function isSafeUrl(value: string): boolean {
  const collapsed = value
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\x00-\x20]/g, '')
    .toLowerCase();
  if (collapsed.startsWith('javascript:')) return false;
  if (collapsed.startsWith('vbscript:')) return false;
  // `data:` is refused wholesale rather than allow-listed by media type: the
  // renderer is not the place to decide which embedded document is harmless.
  if (collapsed.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/.test(collapsed)) {
    return collapsed.startsWith('http:') || collapsed.startsWith('https:');
  }
  return true; // relative, protocol-relative-free, anchor, query
}

function sanitizeAttributes(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED[tag];
  if (!allowed || allowed.length === 0) return '';

  const out: string[] = [];
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if ((name === 'href' || name === 'src') && !isSafeUrl(value)) continue;
    // Rebuilt with double quotes and the value escaped, so a value carrying a
    // quote cannot end the attribute and start a new one.
    const safe = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out.push(`${name}="${safe}"`);
  }
  // A link that opens a new tab gets `rel` whether or not the author wrote one:
  // `target="_blank"` without it hands `window.opener` to the destination.
  if (tag === 'a' && out.some((a) => a.startsWith('target='))) {
    if (!out.some((a) => a.startsWith('rel='))) out.push('rel="noopener noreferrer"');
  }
  return out.length ? ' ' + out.join(' ') : '';
}

export function sanitizePostHtml(input: string): string {
  if (!input) return input;

  let html = input;

  // Comments can hide markup from a later pass (`<!--><img onerror=…>`).
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Drop the tags whose content is as unwelcome as the tag, including an
  // unclosed one at the end of the string.
  for (const tag of DROP_WITH_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    html = html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // Rebuild every remaining tag from the allow-list. An unknown tag is
  // unwrapped rather than deleted, so its text survives — a body that reads
  // `<marquee>hello</marquee>` should still say hello.
  html = html.replace(/<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_full, closing, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase();
    if (!(tag in ALLOWED)) return '';
    if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
    const attrs = sanitizeAttributes(tag, String(rawAttrs));
    return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>`;
  });

  // Anything still shaped like a tag was not matched above (a stray `<` that
  // opens nothing, `<?php`, `<!DOCTYPE`). Escape it so it renders as text.
  html = html.replace(/<(?![a-zA-Z/])/g, '&lt;');

  return html;
}
