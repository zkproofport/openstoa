/**
 * Korean typography contract — static checks over `globals.css` and
 * `layout.tsx` source text. jsdom cannot render real line-breaking/zoom
 * behavior, so these assert the CSS rules and viewport config exist with
 * the correct selectors/values rather than fabricating layout assertions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
const layout = readFileSync(join(process.cwd(), 'src/app/layout.tsx'), 'utf-8');

describe('Korean word-break contract', () => {
  it('html:lang(ko) sets word-break: keep-all (Hangul must not break mid-eojeol)', () => {
    expect(css).toMatch(/html:lang\(ko\)\s*{[^}]*word-break:\s*keep-all;/s);
  });

  it('.os-break-all exists as the explicit opt-out for URLs/hashes/nullifiers', () => {
    expect(css).toMatch(/\.os-break-all\s*{[^}]*word-break:\s*break-all;/s);
  });

  it('the keep-all rule and the break-all opt-out are NOT the same rule (opt-out must be overridable per-element)', () => {
    const keepAllBlock = css.match(/html:lang\(ko\)\s*{[^}]*}/s)?.[0] ?? '';
    expect(keepAllBlock).not.toContain('break-all');
  });

  it("SNSEditor's existing keep-all usage (the one place this already worked) is untouched", () => {
    const editor = readFileSync(join(process.cwd(), 'src/components/SNSEditor.tsx'), 'utf-8');
    expect(editor).toContain("wordBreak: 'keep-all'");
  });
});

describe('language-conditional uppercase label idiom', () => {
  it('.os-label base rule does NOT set text-transform/letter-spacing unconditionally', () => {
    const base = css.match(/\.os-label\s*{([^}]*)}/s)?.[1] ?? '';
    expect(base).not.toContain('text-transform');
    expect(base).not.toContain('letter-spacing');
  });

  it('.os-label:lang(en) is the ONLY place uppercase+tracking is applied', () => {
    expect(css).toMatch(/\.os-label:lang\(en\)\s*{[^}]*text-transform:\s*uppercase;/s);
    expect(css).toMatch(/\.os-label:lang\(en\)\s*{[^}]*letter-spacing:\s*0\.08em;/s);
  });
});

describe('Korean leading (line-height)', () => {
  it('html:lang(ko) sets a relaxed line-height beyond the Latin default', () => {
    const block = css.match(/html:lang\(ko\)\s*{([^}]*)}/s)?.[1] ?? '';
    expect(block).toContain('line-height: var(--leading-relaxed);');
  });
});

describe('Hangul-capable font stack', () => {
  it('--font-sans names a Hangul-capable face (not Inter-only)', () => {
    const block = css.match(/--font-sans:\s*([^;]+);/)?.[1] ?? '';
    expect(block).toMatch(/Noto Sans KR|Apple SD Gothic Neo/);
  });

  it('the Google Fonts @import actually loads the Korean face referenced above', () => {
    expect(css).toContain('family=Noto+Sans+KR');
  });
});

describe('pinch-zoom is not disabled', () => {
  it('layout.tsx viewport export no longer sets maximumScale/userScalable', () => {
    const viewportBlock = layout.match(/export const viewport:\s*Viewport\s*=\s*{([^}]*)};/s)?.[1] ?? '';
    // Match the property assignment specifically (`maximumScale:`), not any
    // mention of the word — the block's own explanatory comment says
    // "maximumScale/userScalable were previously locked..." and a bare
    // substring match would false-positive against its own documentation.
    expect(viewportBlock).not.toMatch(/maximumScale\s*:/);
    expect(viewportBlock).not.toMatch(/userScalable\s*:/);
  });
});

describe('<html lang> follows the active locale', () => {
  it('layout.tsx no longer hardcodes lang="en"', () => {
    expect(layout).not.toContain('<html lang="en"');
  });

  it('layout.tsx resolves the locale server-side and binds it to <html lang>', () => {
    expect(layout).toContain('const locale = await getServerLocale();');
    // Matches any additional attributes (the theme work added
    // `suppressHydrationWarning`). What this test guards is that `lang` is
    // bound to the resolved locale — not the exact shape of the tag.
    expect(layout).toMatch(/<html lang=\{locale\}[^>]*>/);
  });

  it('layout.tsx no longer force-locks the dark class (real theme switching needs this removed)', () => {
    expect(layout).not.toContain('className="dark"');
  });
});
