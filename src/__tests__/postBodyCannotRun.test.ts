/*
 * WHAT WAS WRONG. Post content is deliberately HTML — the app embeds
 * `<img src>` after `/api/upload` — so the renderer treated anything with a
 * tag as markup and skipped escaping. Nothing asked WHICH markup. Measured in
 * a real browser, on a PUBLIC post any visitor can open:
 *
 *   content:  <img src=x onerror="document.title='PWNED-ONERROR'">…
 *   title  ->  "PWNED-ONERROR"      the handler RAN
 *   img[onerror] 1 · svg[onload] 1 · a[href^=javascript:] 1 · iframe 1
 *
 * An HTTP fetch of the same page showed nothing, because the body renders on
 * the client. Checking the served HTML was checking the wrong document.
 *
 * The cases below are grouped by what they defeat: the plain payload, the
 * quoting trick, the entity trick, the "the sanitiser ran once" trick. Each is
 * a way a blacklist stays green while the page still runs, which is why
 * `sanitizePostHtml` rebuilds from an allow-list instead.
 */
import { describe, it, expect } from 'vitest';
import { sanitizePostHtml } from '@/lib/sanitizePostHtml';

const clean = sanitizePostHtml;

/**
 * Attribute names actually present on tags in the output, with quoted values
 * removed first. `onerror` inside a value is text; `onerror` outside one runs.
 */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    const withoutValues = tag.replace(/="[^"]*"/g, '=').replace(/='[^']*'/g, '=');
    for (const m of withoutValues.matchAll(/[\s/]([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=/g)) {
      names.push(m[1].toLowerCase().startsWith('on') ? 'on' : m[1].toLowerCase());
    }
  }
  return names;
}

describe('a post body cannot run', () => {
  it.each([
    '<img src=x onerror="alert(1)">',
    "<img src=x onerror='alert(1)'>",
    '<img src=x onerror=alert(1)>',
    '<img src=x ONERROR="alert(1)">',
    '<img src=x onmouseover="alert(1)">',
    '<body onload="alert(1)">',
    '<div onfocus="alert(1)" tabindex="1">',
  ])('drops the handler in %s', (input) => {
    // Check ATTRIBUTE POSITIONS, not the raw string: a handler that survives
    // only as escaped text inside a value (`src="x&quot; onerror=…"`) is
    // inert, and asserting on the substring would fail a correct output.
    expect(attributeNames(clean(input))).not.toContain('on');
  });

  it.each([
    ['<script>alert(1)</script>', 'script'],
    ['<SCRIPT>alert(1)</SCRIPT>', 'script'],
    ['<svg onload="alert(1)"></svg>', 'svg'],
    ['<iframe src="https://evil.test"></iframe>', 'iframe'],
    ['<object data="evil.swf"></object>', 'object'],
    ['<embed src="evil.swf">', 'embed'],
    ['<style>body{background:url(//evil.test)}</style>', 'style'],
    ['<form action="//evil.test"><input name="p"></form>', 'form'],
    ['<video src="x" onerror="alert(1)"></video>', 'video'],
  ])('removes %s entirely', (input, tag) => {
    expect(clean(input).toLowerCase()).not.toContain(`<${tag}`);
  });

  it.each([
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="java&#9;script:alert(1)">x</a>',
    '<a href="java&#x09;script:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<img src="javascript:alert(1)">',
    '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
  ])('refuses the executable URL in %s', (input) => {
    const out = clean(input).toLowerCase();
    expect(out).not.toContain('javascript');
    expect(out).not.toContain('vbscript');
    expect(out).not.toContain('data:text/html');
  });

  /*
   * `<img/src=x/onerror=…>` is a widely-repeated bypass, and it is not one.
   * Asked directly (Chromium, `file://` fixture), the parser produces a single
   * `src` attribute for `<img/src=x/onerror="…">`, for `<img src=x/onerror="…">`
   * and for `<img src='x" onerror="…' alt="a">` — no handler, nothing runs.
   * Recorded here because the obvious "fix" is to treat `/` as an attribute
   * separator, which also rewrites every slash in a legitimate URL.
   */
  it('the slash forms never carried a handler in the first place', () => {
    for (const input of [
      '<img/src=x/onerror="alert(1)">',
      '<img src=x/onerror="alert(1)">',
    ]) {
      expect(attributeNames(clean(input))).not.toContain('on');
    }
  });

  it('a comment cannot smuggle markup past the tag pass', () => {
    const out = clean('<!--><img src=x onerror="alert(1)">-->');
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
  });

  it('a quote inside an attribute value cannot start a new attribute', () => {
    const out = clean('<img src=\'x" onerror="alert(1)\' alt="a">');
    expect(attributeNames(out)).not.toContain('on');
    // It survives only as escaped text, which renders and does nothing.
    expect(out).toContain('&quot;');
  });

  it('nested tags do not reassemble after one pass', () => {
    // `<scr<script>ipt>` is the classic single-pass-strip defeat.
    expect(clean('<scr<script>ipt>alert(1)</scr</script>ipt>')).not.toContain('<script');
  });

  it('an unclosed dangerous tag still loses its content', () => {
    expect(clean('text<script>alert(1)').toLowerCase()).not.toContain('<script');
  });
});

describe('a post body still renders what the product emits', () => {
  it('keeps an uploaded image', () => {
    const out = clean('<img src="/api/media/topics/a/posts/b/p.png" alt="photo" width="400">');
    expect(out).toContain('src="/api/media/topics/a/posts/b/p.png"');
    expect(out).toContain('alt="photo"');
    expect(out).toContain('width="400"');
  });

  it('keeps an https link and adds rel when it opens a new tab', () => {
    const out = clean('<a href="https://example.com" target="_blank">go</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('>go</a>');
  });

  it('keeps line breaks, emphasis and lists', () => {
    const out = clean('<p>one<br><b>two</b><i>three</i></p><ul><li>a</li></ul>');
    expect(out).toBe('<p>one<br><b>two</b><i>three</i></p><ul><li>a</li></ul>');
  });

  it('unwraps an unknown tag but keeps its words', () => {
    expect(clean('<marquee>hello</marquee>')).toBe('hello');
  });

  it('leaves ordinary text alone, including Korean and emoji', () => {
    for (const text of ['그냥 텍스트입니다', '이모지 🎉 포함', 'a < b and c > d', '']) {
      expect(clean(text)).toContain(text.split('<')[0]);
    }
  });

  it('a bare < becomes text rather than swallowing the rest of the body', () => {
    expect(clean('5 < 6 and the rest survives')).toContain('the rest survives');
  });

  it('is idempotent — sanitising twice changes nothing', () => {
    const once = clean('<p>hi<img src="/x.png" onerror="alert(1)"><a href="javascript:x">y</a></p>');
    expect(clean(once)).toBe(once);
  });
});
