// @vitest-environment jsdom
/**
 * Design-token sweep guard.
 *
 * Light mode is a REAL shipped surface: `globals.css` defines a full light
 * palette under `@media (prefers-color-scheme: light)`, so a viewer whose OS
 * is in light mode gets light tokens. Components that hardcode
 * `rgba(255,255,255,…)` overlays therefore paint white-on-white, and
 * components that hardcode `rgba(120,140,255,…)` paint an off-palette blue
 * that is not the brand indigo in either theme. This file fails the build if
 * either pattern (or any raw hex, bare `monospace`, or sub-12px font size)
 * comes back into the swept components.
 *
 * Edge-case matrix rows covered here:
 *   contract   — every swept file is scanned; adding a new hardcoded color to
 *                any of them fails, so the sweep cannot silently regress
 *   boundary   — the 12px type floor is asserted as `< 12 fails, 12 passes`
 *   hostile    — the hex scan runs over the raw source text, so a color
 *                smuggled into a comment or a template literal still trips it
 *   empty      — a file that legitimately contains zero matches passes (the
 *                assertion is on the match list, not on a non-empty diff)
 *   UTF-8      — Badge renders Korean labels; the ko locale is exercised
 *   integrity  — Badge's collapse to three tones is asserted per TYPE, so a
 *                dropped badge type is caught, not just a recolored one
 *   ui         — the uppercase+tracking label idiom must come from `.os-label`
 *                (which gates it to :lang(en)), never hand-rolled inline
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Badge from '@/components/Badge';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import type { Locale } from '@/lib/i18n';

/** The files this sweep owns. */
const SWEPT_FILES = [
  'src/components/LeftSidebar.tsx',
  'src/components/PostCard.tsx',
  'src/components/Badge.tsx',
  'src/components/ChatRail.tsx',
  'src/components/ChatPanel.tsx',
  'src/components/RightSidebar.tsx',
  'src/components/post/PostActionBar.tsx',
] as const;

/**
 * Values deliberately kept, each with the reason. EMPTY BY DESIGN — the sweep
 * left no hardcoded color, bare `monospace`, or sub-floor font size behind in
 * these seven files. Add an entry here (never a bare exemption in the regex)
 * if a future change genuinely needs one, e.g.:
 *   { file: 'X.tsx', value: '#abcdef', reason: '...' }
 */
const ALLOWLIST: Array<{ file: string; value: string; reason: string }> = [];

function isAllowed(file: string, value: string): boolean {
  return ALLOWLIST.some((a) => a.file === file && a.value === value);
}

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf-8');
}

describe('token sweep — no hardcoded overlay colors', () => {
  it.each(SWEPT_FILES)('%s has no rgba(255,255,255,…) white overlay', (file) => {
    // A white overlay is invisible on the light ground — the exact defect
    // this sweep exists to remove.
    const hits = source(file).match(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it.each(SWEPT_FILES)('%s has no rgba(120,140,255,…) off-palette blue', (file) => {
    // Not the brand indigo (--color-brand-primary) in either theme.
    const hits = source(file).match(/rgba\(\s*120\s*,\s*140\s*,\s*255\s*,/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it.each(SWEPT_FILES)('%s has no rgba() literal at all', (file) => {
    // Every rgba() in these files was an alpha overlay on an assumed-dark
    // ground. There is no legitimate remaining use, so the rule is absolute
    // rather than a color-by-color denylist that the next one slips past.
    const hits = source(file).match(/rgba\([^)]*\)/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it.each(SWEPT_FILES)('%s has no raw hex color literal', (file) => {
    // 3/4/6/8-digit hex. `#{tag.name}` and other JSX text cannot match: the
    // char class is hex-only and the length is pinned by the word boundary.
    const hits = source(file).match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });
});

describe('token sweep — typography', () => {
  it.each(SWEPT_FILES)('%s uses var(--font-mono), never the bare `monospace` keyword', (file) => {
    const hits = source(file).match(/fontFamily:\s*'monospace'/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it.each(SWEPT_FILES)('%s has no numeric fontSize below the 12px floor', (file) => {
    // Boundary: 11 fails, 12 passes. Sizes >= 12 that are still numeric
    // literals (e.g. the chat bubble's deliberate 14/13) are left alone —
    // see the bubble exception test below.
    const hits = [...source(file).matchAll(/fontSize:\s*(\d+)\b/g)]
      .filter((m) => Number(m[1]) < 12)
      .map((m) => m[0]);
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it('the chat bubble keeps its deliberate, user-approved 14/13px size', () => {
    // EXCEPTION, kept on purpose: the 16px body floor made bubbles read as
    // oversized and the user asked for the pre-migration size back. Only the
    // bubble's color and radius were tokenized.
    expect(source('src/components/ChatPanel.tsx')).toContain('fontSize: roomy ? 14 : 13');
  });

  it.each(['src/components/ChatRail.tsx', 'src/components/ChatPanel.tsx'])(
    '%s never hand-rolls uppercase/letter-spacing — that idiom is `.os-label`, gated to :lang(en)',
    (file) => {
      // ChatRail's tab labels and header title, and ChatPanel's "Live Chat",
      // all translate to Korean; uppercase is a no-op on Hangul and tracking
      // reads as broken kerning, which is why globals.css gates both.
      const src = source(file);
      expect(src).not.toMatch(/textTransform:\s*'uppercase'/);
      expect(src).not.toMatch(/letterSpacing:\s*'0\.0[468]em'/);
      expect(src).toContain('className="os-label"');
    },
  );

  it('globals.css still gates the uppercase idiom to :lang(en) (the class the sweep now relies on)', () => {
    const css = source('src/app/globals.css');
    expect(css).toMatch(/\.os-label:lang\(en\)\s*{[^}]*text-transform:\s*uppercase;/s);
  });
});

describe('token sweep — on-chain is the quietest treatment, never an off-palette violet', () => {
  it.each(['src/components/PostCard.tsx', 'src/components/LeftSidebar.tsx', 'src/components/post/PostActionBar.tsx'])(
    '%s no longer paints the on-chain surface violet',
    (file) => {
      const src = source(file);
      // The violet family (#8b5cf6 / #a78bfa / rgba(139,92,246,…)) is in no
      // palette; both hex and rgba forms are already covered above, but this
      // asserts the intent explicitly so a future reviewer sees the rule.
      expect(src).not.toMatch(/8b5cf6|a78bfa|139\s*,\s*92\s*,\s*246/i);
    },
  );

  it('PostCard renders the "Recorded on Base" chip as a transparent outline', () => {
    const src = source('src/components/PostCard.tsx');
    const chip = src.slice(src.indexOf('Recorded on Base badge'), src.indexOf('Reaction stats'));
    expect(chip).toContain("background: 'transparent'");
    expect(chip).toContain("border: '1px solid var(--color-border-default)'");
    expect(chip).toContain("color: 'var(--color-text-tertiary)'");
  });
});

// ─── Badge — one treatment per tone, every TYPE still rendering ──────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderBadge(node: React.ReactElement, locale: Locale = 'en') {
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
    await Promise.resolve();
  });
}

function badgeEl(): HTMLElement {
  return container.querySelector('[data-badge-type]') as HTMLElement;
}

describe('Badge — collapsed to three tones, every type intact', () => {
  const CASES: Array<{ type: string; tone: string; label: string }> = [
    { type: 'kyc', tone: 'verified', label: 'KYC verified' },
    { type: 'country', tone: 'verified', label: 'Country' },
    { type: 'workspace', tone: 'verified', label: 'Org verified' },
    { type: 'oidc', tone: 'verified', label: 'OIDC verified' },
    { type: 'ai', tone: 'neutral', label: 'AI' },
    { type: 'onchain', tone: 'onchain', label: 'onchain' },
  ];

  it.each(CASES)('type=$type still renders, with tone=$tone and its label', async ({ type, tone, label }) => {
    await renderBadge(<Badge type={type} />);
    const el = badgeEl();
    expect(el).not.toBeNull();
    expect(el.getAttribute('data-badge-tone')).toBe(tone);
    expect(el.textContent).toContain(label);
  });

  it('an unknown type falls back to the neutral tone and shows the raw type as its label', async () => {
    await renderBadge(<Badge type="totally-new-proof" />);
    expect(badgeEl().getAttribute('data-badge-tone')).toBe('neutral');
    expect(badgeEl().textContent).toContain('totally-new-proof');
  });

  it('explicit props still win over the i18n fallbacks (label / country / domain)', async () => {
    await renderBadge(<Badge type="country" country="KR" />);
    expect(badgeEl().textContent).toContain('KR');
    await renderBadge(<Badge type="workspace" domain="masselabs.io" />);
    expect(badgeEl().textContent).toContain('masselabs.io');
    await renderBadge(<Badge type="kyc" label="Custom" />);
    expect(badgeEl().textContent).toContain('Custom');
  });

  it('renders Korean labels intact (UTF-8, no uppercase mangling)', async () => {
    await renderBadge(<Badge type="kyc" />, 'ko');
    expect(badgeEl().textContent).toContain('KYC 인증됨');
  });

  it('every tone uses only token colors — no literal color survives on the element', async () => {
    for (const { type } of CASES) {
      await renderBadge(<Badge type={type} />);
      const style = badgeEl().getAttribute('style') ?? '';
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(style).not.toMatch(/rgba?\(/);
      expect(style).toMatch(/var\(--color-/);
    }
  });

  it('the verified tone is the accent role, on a transparent fill with a matching border', async () => {
    await renderBadge(<Badge type="kyc" />);
    const style = badgeEl().getAttribute('style') ?? '';
    expect(style).toContain('var(--color-brand-accent)');
    expect(style).toContain('transparent');
    expect(style).toContain('var(--radius-control)');
  });
});
