/**
 * Design token contract — `src/app/globals.css` (source of truth for the
 * cascade) cross-checked against `src/styles/tokens.ts` (typed JS mirror)
 * and `src/hooks/useMediaQuery.ts` (the pre-existing, load-bearing
 * DESKTOP_CHAT_QUERY breakpoint).
 *
 * jsdom has no layout/paint engine and does not evaluate `@media
 * (prefers-color-scheme)` or resolve the CSS cascade across stylesheets, so
 * "both themes work via media query AND override, each winning correctly"
 * cannot be verified via getComputedStyle here. Instead this file statically
 * parses globals.css text and asserts: (a) the three color blocks exist with
 * the expected selectors, in the order that makes the override win via CSS
 * specificity (attribute selector > bare :root), (b) each block sets the
 * FULL semantic color set (not a partial override — a partial override
 * couldn't out-rank the media query for every token), and (c) the JS/CSS
 * hex values are byte-for-byte identical. Real-browser verification of the
 * rendered cascade is a manual/E2E concern, not a jsdom concern — flagged
 * explicitly rather than faked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { lightColors, darkColors, RADIUS, SPACING, BREAKPOINTS, TOUCH_TARGET_MIN } from '@/styles/tokens';
import { DESKTOP_CHAT_QUERY } from '@/hooks/useMediaQuery';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');

/** Extracts the body of the first `{...}` block following `selector`, with
 *  simple brace-depth matching (sufficient here — none of these blocks
 *  contain nested rule blocks of their own, except the media-query wrapper,
 *  which callers unwrap by passing the selector chain accordingly). */
function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`selector not found in globals.css: ${selector}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unbalanced braces for selector: ${selector}`);
}

function colorVarsIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--(color-[a-z0-9-]+):\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim();
  return out;
}

describe('globals.css theme cascade — structural contract', () => {
  const REQUIRED_COLOR_VARS = [
    'color-bg-primary',
    'color-bg-secondary',
    'color-bg-tertiary',
    'color-text-primary',
    'color-text-secondary',
    'color-text-tertiary',
    'color-text-inverted',
    'color-brand-primary',
    'color-brand-primary-hover',
    'color-brand-primary-muted',
    'color-brand-accent',
    'color-border-default',
    'color-border-strong',
    'color-status-success',
    'color-status-warning',
    'color-status-danger',
  ];

  it('base :root sets every required semantic color var (dark fallback)', () => {
    const block = extractBlock(css, ':root {');
    const vars = colorVarsIn(block);
    for (const name of REQUIRED_COLOR_VARS) {
      expect(vars, name).toHaveProperty(name);
    }
    expect(vars['color-bg-primary']).toBe(darkColors.background.primary.toLowerCase());
  });

  it('@media (prefers-color-scheme: light) sets every required var (full override, not partial)', () => {
    // Search for the actual rule (trailing " {"), not the module doc-comment
    // above it, which also mentions "@media (prefers-color-scheme: light)"
    // in backticked prose and would otherwise match first.
    const mediaStart = css.indexOf('@media (prefers-color-scheme: light) {');
    expect(mediaStart).toBeGreaterThan(-1);
    // `:root:not([data-theme])`, not a bare `:root`: the OS preference must not
    // be able to override the user's explicit choice, so this block is scoped
    // to the pre-choice state only. The theme itself comes from `data-theme`
    // (see theme.test.tsx) — this block still has to carry the full light
    // palette for the moments before the pre-paint script stamps it.
    const block = extractBlock(css.slice(mediaStart), ':root:not([data-theme]) {');
    const vars = colorVarsIn(block);
    for (const name of REQUIRED_COLOR_VARS) {
      expect(vars, name).toHaveProperty(name);
    }
    expect(vars['color-bg-primary']).toBe(lightColors.background.primary.toLowerCase());
  });

  it("[data-theme='dark'] override sets every required var, so it out-ranks the light media query", () => {
    const block = extractBlock(css, ":root[data-theme='dark'] {");
    const vars = colorVarsIn(block);
    for (const name of REQUIRED_COLOR_VARS) {
      expect(vars, name).toHaveProperty(name);
    }
    expect(vars['color-bg-primary']).toBe(darkColors.background.primary.toLowerCase());
  });

  it("[data-theme='light'] override sets every required var, so it out-ranks the dark default", () => {
    const block = extractBlock(css, ":root[data-theme='light'] {");
    const vars = colorVarsIn(block);
    for (const name of REQUIRED_COLOR_VARS) {
      expect(vars, name).toHaveProperty(name);
    }
    expect(vars['color-bg-primary']).toBe(lightColors.background.primary.toLowerCase());
  });

  it('attribute-selector blocks use [data-theme=...] (higher specificity than a bare media-wrapped :root)', () => {
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{/);
    expect(css).toMatch(/:root\[data-theme='light'\]\s*{/);
  });
});

describe('globals.css <-> src/styles/tokens.ts — single source of truth', () => {
  it.each([
    ['background.primary', 'color-bg-primary'],
    ['background.secondary', 'color-bg-secondary'],
    ['background.tertiary', 'color-bg-tertiary'],
    ['text.primary', 'color-text-primary'],
    ['text.secondary', 'color-text-secondary'],
    ['text.tertiary', 'color-text-tertiary'],
    ['brand.primary', 'color-brand-primary'],
    ['brand.primaryHover', 'color-brand-primary-hover'],
    ['brand.accent', 'color-brand-accent'],
    ['border.default', 'color-border-default'],
    ['status.danger', 'color-status-danger'],
  ])('dark %s matches --%s', (path, cssVar) => {
    const [group, key] = path.split('.') as [keyof typeof darkColors, string];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tsValue = ((darkColors[group] as any)[key] as string).toLowerCase();
    const block = extractBlock(css, ':root {');
    expect(colorVarsIn(block)[cssVar]).toBe(tsValue);
  });
});

describe('spacing / radius / breakpoint / touch-target tokens', () => {
  it('spacing scale is exactly 4/8/12/16/24/32/48, in both CSS and TS', () => {
    expect(SPACING).toEqual({ 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 });
    for (const px of Object.values(SPACING)) {
      expect(css).toContain(`: ${px}px;`);
    }
  });

  it('radius scale collapses to exactly 4 named steps', () => {
    expect(RADIUS).toEqual({ control: 6, card: 12, modal: 16, pill: 999 });
    expect(css).toContain('--radius-control: 6px;');
    expect(css).toContain('--radius-card: 12px;');
    expect(css).toContain('--radius-modal: 16px;');
    expect(css).toContain('--radius-pill: 999px;');
  });

  it('breakpoint cut points match the pre-existing DESKTOP_CHAT_QUERY (must not drift)', () => {
    expect(DESKTOP_CHAT_QUERY).toBe('(min-width: 1024px)');
    expect(BREAKPOINTS.desktopMin).toBe(1024);
    expect(css).toContain('--bp-mobile-max: 767px;');
    expect(css).toContain('--bp-tablet-max: 1023px;');
  });

  it('touch target minimum is 44px in both CSS and TS, and is wired into interactive utility classes', () => {
    expect(TOUCH_TARGET_MIN).toBe(44);
    expect(css).toContain('--touch-target-min: 44px;');
    // Guard: removing the min-height wiring from a control class should fail
    // this test, not just look wrong in a screenshot.
    const btn = extractBlock(css, '.os-btn {');
    expect(btn).toContain('min-height: var(--touch-target-min);');
    const input = extractBlock(css, '.os-input {');
    expect(input).toContain('min-height: var(--touch-target-min);');
  });
});

describe('typography scale', () => {
  it('is exactly 7 named steps, floored at 12px', () => {
    const re = /--text-([a-z-]+):\s*([\d.]+)rem;/g;
    const steps: { name: string; px: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) steps.push({ name: m[1], px: parseFloat(m[2]) * 16 });
    expect(steps).toHaveLength(7);
    for (const s of steps) expect(s.px).toBeGreaterThanOrEqual(12);
  });

  it('the 12px step is --text-label and is documented as uppercase-Latin-only', () => {
    expect(css).toContain('--text-label: 0.75rem; /* 12px — uppercase Latin labels only */');
  });

  it('the 16px step (--text-body) exists — the Korean/prose floor and form-input zoom-safe size', () => {
    expect(css).toContain('--text-body: 1rem; /* 16px — body copy floor / form inputs */');
  });
});
