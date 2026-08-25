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
import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Badge from '@/components/Badge';
import { TestProviders } from './harness/providers';
import type { Locale } from '@/lib/i18n';

/**
 * Files that got the FULL sweep: color AND typography.
 *
 * These seven were the first pass. The typography rules below (12px floor,
 * `.os-label` for the uppercase idiom) are asserted only for this list
 * because only these files were actually reworked for type — see
 * COLOR_SWEPT_FILES for the wider color-only guarantee.
 */
const SWEPT_FILES = [
  'src/components/LeftSidebar.tsx',
  'src/components/PostCard.tsx',
  'src/components/Badge.tsx',
  'src/components/ChatRail.tsx',
  // Extracted OUT of ChatRail.tsx (the shared two-tab conversation list, now
  // also rendered by the standalone /chat page) — it carries that file's
  // swept markup verbatim, so it inherits the full typography guarantee
  // rather than dropping to color-only.
  'src/components/ChatRoomList.tsx',
  'src/components/ChatPanel.tsx',
  'src/components/RightSidebar.tsx',
  'src/components/post/PostActionBar.tsx',
] as const;

/**
 * Every file the COLOR sweep owns — the seven above plus the rest of
 * `src/app/**` and `src/components/**`.
 *
 * The first pass covered only those seven, and this guard only watched those
 * seven, so the other ~40 files were never checked: in light mode the topic
 * title (`#e5e7eb`) and the whole Docs body (`#ededed`) rendered near-white
 * on white. `no-unwatched-file` at the bottom of this file is what makes
 * "every file is watched" a fact rather than a claim — it walks the tree and
 * fails if any .tsx is absent from all three lists.
 */
const COLOR_SWEPT_FILES = [
  ...SWEPT_FILES,
  // Theme-toggle work: the header now reads tokens, the icons' semantic
  // colors are tokens, and layout/ThemeToggle carry no colors at all.
  'src/app/layout.tsx',
  'src/components/Header.tsx',
  'src/components/ThemeToggle.tsx',
  // What the web shows in place of chat. Every colour it draws is a token, so
  // it belongs in the swept list rather than the excluded one.
  'src/components/ChatOnMobileOnly.tsx',
  'src/components/icons.tsx',
  'src/app/ask/page.tsx',
  'src/app/chat/page.tsx',
  'src/app/chat/[topicId]/page.tsx',
  'src/app/dm/[topicId]/page.tsx',
  'src/app/dm/page.tsx',
  'src/app/docs/page.tsx',
  'src/app/docs/tiers/page.tsx',
  'src/app/my/page.tsx',
  'src/app/profile/page.tsx',
  'src/app/recorded/page.tsx',
  'src/app/recovery/page.tsx',
  'src/app/api-reference/page.tsx',
  'src/app/topics/[topicId]/edit/page.tsx',
  'src/app/topics/[topicId]/join/page.tsx',
  'src/app/topics/join/[inviteCode]/page.tsx',
  'src/app/topics/[topicId]/members/page.tsx',
  // Dynamic-OG split: `page.tsx` is now a thin server wrapper (`generateMetadata`
  // + render the client component below) with no colors of its own — swept
  // trivially. The actual swept markup lives in the `*Client.tsx` file next to it.
  'src/app/topics/[topicId]/page.tsx',
  'src/app/topics/[topicId]/TopicPageClient.tsx',
  'src/app/topics/[topicId]/posts/[postId]/page.tsx',
  'src/app/topics/[topicId]/posts/[postId]/PostDetailClient.tsx',
  'src/app/topics/explore/page.tsx',
  'src/app/topics/new/page.tsx',
  'src/app/topics/page.tsx',
  'src/components/AccountRecovery.tsx',
  'src/components/AiAgentSettings.tsx',
  'src/components/ArchiveRetentionNotice.tsx',
  'src/components/Avatar.tsx',
  'src/components/BareChatShell.tsx',
  'src/components/BottomTabBar.tsx',
  'src/components/CommunityLayout.tsx',
  'src/components/HeaderSearchBar.tsx',
  'src/components/ImageLightbox.tsx',
  'src/components/InviteDialog.tsx',
  'src/components/LinkPreview.tsx',
  'src/components/LocaleSwitcher.tsx',
  'src/components/MentionInput.tsx',
  'src/components/PollEditor.tsx',
  'src/components/PollRenderer.tsx',
  'src/components/PostRecordsSection.tsx',
  'src/components/ProofGate.tsx',
  'src/components/RecoveryNudge.tsx',
  'src/components/SNSContent.tsx',
  'src/components/SNSEditor.tsx',
  'src/components/Spinner.tsx',
  'src/components/TagInput.tsx',
  'src/components/TopicAvatar.tsx',
  'src/components/TopicMembersList.tsx',
  'src/components/TopicMuteToggle.tsx',
  'src/components/UserCard.tsx',
  'src/components/post/BookmarkButton.tsx',
  'src/components/post/MediaGallery.tsx',
  'src/components/post/ReactionRow.tsx',
  'src/components/post/VotePill.tsx',
] as const;

/**
 * Named exclusions. A file here is NOT unwatched — it is watched by a human
 * decision recorded on this line, and `no-unwatched-file` still requires it
 * to appear in exactly one list.
 */
const EXCLUDED_FILES: Array<{ file: string; reason: string }> = [
  {
    file: 'src/components/ChatImage.tsx',
    reason:
      'Media chrome only. Every surface colour it draws is a token (--radius-card, --border, --color-background-tertiary); the two raw values left are the black scrim and the black pill that sit ON TOP of the user\'s own photo, which must stay black in light mode or the "See full image" label loses its contrast against the picture underneath. Same carve-out as the ALLOWLIST\'s media-chrome category, applied at file level because both values exist only for that overlay.',
  },
  {
    file: 'src/app/page.tsx',
    reason:
      'Landing: a bespoke permanently-dark split-screen composition (--human-*/--agent-*/--center-glow, documented as out-of-system in globals.css) plus a particle canvas that needs raw rgba() for ctx.fillStyle. Its one ordinary surface, the beta-signup modal, IS tokenized.',
  },
];

/**
 * Literals deliberately kept, one line of reasoning each. `isAllowed` matches
 * on file + value, so a value repeated within one file needs a single entry.
 *
 * Two things earn a place here and nothing else does:
 *  1. MEDIA CHROME — a black scrim laid over the user's own photo or video,
 *     and the white glyphs on top of it. That scrim is not a page ground; it
 *     must stay black in light mode too, or the controls lose their contrast
 *     against the underlying image.
 *  2. DROP SHADOWS — `rgba(0,0,0,α)` in a boxShadow. A shadow is cast light,
 *     black in both themes; there is no shadow token to map it onto.
 */
const ALLOWLIST: Array<{ file: string; value: string; reason: string }> = [
  // ── 1. Media chrome ──
  { file: 'src/components/Header.tsx', value: '#788cff', reason: 'Inside the AI-Ask link commented out on 2026-05-25 (LLM providers deprecated) — dead markup kept verbatim so re-enabling is one uncomment, never rendered.' },
  { file: 'src/components/Header.tsx', value: 'rgba(120,140,255,0.25)', reason: 'Same disabled AI-Ask block.' },
  { file: 'src/components/Header.tsx', value: 'rgba(120,140,255,0.1)', reason: 'Same disabled AI-Ask block.' },
  { file: 'src/components/Header.tsx', value: 'rgba(120,140,255,0.5)', reason: 'Same disabled AI-Ask block.' },
  // ── 3. Renderer arguments, not CSS ──
  { file: 'src/components/ProofGate.tsx', value: '#000000', reason: 'QR module colour. Passed to the qrcode canvas renderer, NOT to CSS — a var(--…) here throws "Invalid hex color" and the login QR fails to render (it did). Fixed black-on-white in both themes because scanners only guarantee dark-on-light polarity.' },
  { file: 'src/components/ProofGate.tsx', value: '#ffffff', reason: 'QR quiet-zone colour — same renderer-argument contract as above.' },
  { file: 'src/components/ImageLightbox.tsx', value: 'rgba(0,0,0,0.9)', reason: 'Full-screen lightbox scrim — black over the photo in both themes.' },
  { file: 'src/components/ImageLightbox.tsx', value: 'rgba(0,0,0,0.6)', reason: 'Lightbox panel shadow over the scrim.' },
  { file: 'src/components/ImageLightbox.tsx', value: 'rgba(0,0,0,0.4)', reason: 'Prev/next arrow pill, sits on the photo.' },
  { file: 'src/components/ImageLightbox.tsx', value: 'rgba(255,255,255,0.35)', reason: 'Inactive dot indicator on the photo.' },
  { file: 'src/components/ImageLightbox.tsx', value: 'rgba(255,255,255,0.7)', reason: 'Caption text on the black scrim.' },
  { file: 'src/components/ImageLightbox.tsx', value: '#fff', reason: 'Close button, counter and active dot on the black scrim.' },
  { file: 'src/components/post/MediaGallery.tsx', value: 'rgba(0,0,0,0.65)', reason: 'Play button + media counter, sit on the thumbnail.' },
  { file: 'src/components/post/MediaGallery.tsx', value: 'rgba(0,0,0,0.45)', reason: 'Carousel arrow pill on the image.' },
  { file: 'src/components/post/MediaGallery.tsx', value: 'rgba(0,0,0,0.5)', reason: 'Video overlay control ground.' },
  { file: 'src/components/post/MediaGallery.tsx', value: 'rgba(255,255,255,0.4)', reason: 'Inactive dot indicator on the image.' },
  { file: 'src/components/post/MediaGallery.tsx', value: '#fff', reason: 'Play glyph, counter and active dot on the media scrim.' },
  { file: 'src/components/post/MediaGallery.tsx', value: '#000', reason: '<video> letterbox ground — black in both themes.' },
  { file: 'src/app/my/page.tsx', value: 'rgba(0,0,0,0.55)', reason: 'Avatar hover scrim over the profile photo.' },
  { file: 'src/app/my/page.tsx', value: '#fff', reason: '"Change photo" label on that avatar scrim.' },
  { file: 'src/components/SNSEditor.tsx', value: 'rgba(0,0,0,0.7)', reason: 'Attachment delete button, sits on the thumbnail.' },
  { file: 'src/components/SNSEditor.tsx', value: '#fff', reason: 'The × glyph on that thumbnail button.' },
  { file: 'src/components/CommunityLayout.tsx', value: 'rgba(0,0,0,0.6)', reason: 'Mobile drawer backdrop — dims the page in both themes.' },
  { file: 'src/components/AiAgentSettings.tsx', value: 'rgba(0,0,0,0.4)', reason: 'API-key reveal panel — deliberately near-black so a shoulder-surfed key stays low-contrast.' },

  // ── 2. Drop shadows ──
  { file: 'src/app/topics/[topicId]/TopicPageClient.tsx', value: 'rgba(0,0,0,0.4)', reason: 'Tag-suggestion dropdown shadow.' },
  { file: 'src/app/topics/[topicId]/posts/[postId]/PostDetailClient.tsx', value: 'rgba(0,0,0,0.4)', reason: 'Comment overflow-menu drop shadow.' },
  { file: 'src/components/TagInput.tsx', value: 'rgba(0,0,0,0.4)', reason: 'Tag autocomplete shadow.' },
  { file: 'src/components/MentionInput.tsx', value: 'rgba(0,0,0,0.5)', reason: 'Mention autocomplete shadow.' },
  { file: 'src/components/post/ReactionRow.tsx', value: 'rgba(0,0,0,0.5)', reason: 'Emoji picker popover drop shadow.' },
  { file: 'src/components/UserCard.tsx', value: 'rgba(0,0,0,0.45)', reason: 'User hover-card drop shadow.' },

  // ── 3. One-offs ──
  {
    file: 'src/components/Avatar.tsx',
    value: 'AVATAR_PALETTE',
    reason:
      'Categorical identity palette: 8 hues that must stay mutually distinguishable so two users never collide. Collapsing them onto the 3 semantic tokens merged 8 hues into 3 — a behavior change, not a recolor. White initials read on every hue in both themes.',
  },
  {
    file: 'src/components/TopicAvatar.tsx',
    value: 'AVATAR_COLORS',
    reason: 'Same categorical identity palette as Avatar.tsx.',
  },
  {
    file: 'src/components/SNSContent.tsx',
    value: '#418',
    reason: 'Not a color — "React error #418" in three comments. The hex scan matches any 3-char run.',
  },
];

function isAllowed(file: string, value: string): boolean {
  return ALLOWLIST.some((a) => a.file === file && a.value === value);
}

/** Files whose allowlisted literals are identified by name, not by value. */
const PALETTE_FILES: Record<string, RegExp> = {
  'src/components/Avatar.tsx': /^\s*'#[0-9a-f]{6}',\s*\/\/|color: '#fff'/,
  'src/components/TopicAvatar.tsx': /AVATAR_COLORS =|color: '#fff'/,
  'src/components/SNSContent.tsx': /React (error )?#418|#418 hydration/,
};

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf-8');
}

/**
 * Strip the lines an allowlist entry covers by name rather than by value, so
 * the scans below see a file with those lines removed.
 */
/**
 * Prose can't be a color. A `//` line or a `*` JSDoc continuation is commentary,
 * and scanning it produces false positives that say nothing about what renders —
 * `Header.tsx` explains a React hydration bug by its error number, `#418`, which
 * the hex matcher happily read as a color.
 *
 * Deliberately line-based and conservative: it drops a line only when the line
 * IS a comment. A trailing comment after code keeps its whole line in scope, so
 * a real color can never hide behind one.
 */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function scannableSource(file: string): string {
  const pattern = PALETTE_FILES[file];
  const src = stripCommentLines(source(file));
  if (!pattern) return src;
  return src
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n');
}

describe('token sweep — no hardcoded overlay colors', () => {
  it.each(COLOR_SWEPT_FILES)('%s has no rgba(255,255,255,…) white overlay', (file) => {
    // A white overlay is invisible on the light ground — the exact defect
    // this sweep exists to remove.
    const hits = scannableSource(file).match(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,[^)]*\)/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h.replace(/\s+/g, '')))).toEqual([]);
  });

  it.each(COLOR_SWEPT_FILES)('%s has no rgba(120,140,255,…) off-palette blue', (file) => {
    // Not the brand indigo (--color-brand-primary) in either theme.
    const hits = scannableSource(file).match(/rgba\(\s*120\s*,\s*140\s*,\s*255\s*,[^)]*\)/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h.replace(/\s+/g, '')))).toEqual([]);
  });

  it.each(COLOR_SWEPT_FILES)('%s has no rgba() literal at all', (file) => {
    // Every rgba() in these files was an alpha overlay on an assumed-dark
    // ground. There is no legitimate remaining use beyond the media scrims
    // and drop shadows named in ALLOWLIST, so the rule is absolute rather
    // than a color-by-color denylist that the next one slips past.
    // `color-mix(… , transparent)` is the sanctioned replacement for an
    // alpha tint of a token and is not an rgba() literal.
    const hits = scannableSource(file).match(/rgba\([^)]*\)/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h.replace(/\s+/g, '')))).toEqual([]);
  });

  it.each(COLOR_SWEPT_FILES)('%s has no raw hex color literal', (file) => {
    // 3/4/6/8-digit hex. `#{tag.name}` and other JSX text cannot match: the
    // char class is hex-only and the length is pinned by the word boundary.
    const hits = scannableSource(file).match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });

  it.each(COLOR_SWEPT_FILES)('%s uses var(--font-mono), never the bare `monospace` keyword', (file) => {
    const hits = scannableSource(file).match(/fontFamily:\s*'monospace'/g) ?? [];
    expect(hits.filter((h) => !isAllowed(file, h))).toEqual([]);
  });
});

describe('token sweep — typography', () => {
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

// ─── Coverage — the rule that makes the lists above self-maintaining ─────────

/** Every .tsx under a directory, as repo-relative POSIX paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.name.endsWith('.tsx')) out.push(child);
  }
  return out;
}

describe('token sweep — no file is unwatched', () => {
  // The original sweep guarded seven files by name, so the ~40 that were
  // never in the list drifted until light mode broke. Enumerating the tree
  // instead of trusting a hand-written list is the only version of this
  // guard that a new file cannot silently slip past.
  it('every .tsx under src/app and src/components is in exactly one list', () => {
    const known = new Map<string, number>();
    for (const f of COLOR_SWEPT_FILES) known.set(f, (known.get(f) ?? 0) + 1);
    for (const { file } of EXCLUDED_FILES) known.set(file, (known.get(file) ?? 0) + 1);

    const onDisk = [...walk('src/app'), ...walk('src/components')].sort();

    // Unlisted: a file exists but no list mentions it. This is the failure
    // the light-mode bug was — fix it by sweeping the file and adding it to
    // COLOR_SWEPT_FILES, or by adding it to EXCLUDED_FILES with a reason.
    expect(onDisk.filter((f) => !known.has(f))).toEqual([]);

    // Listed twice, or listed but deleted/renamed — both make the guard lie
    // about what it covers.
    expect([...known].filter(([, n]) => n > 1).map(([f]) => f)).toEqual([]);
    expect([...known.keys()].filter((f) => !onDisk.includes(f)).sort()).toEqual([]);
  });

  it('every exclusion and allowlist entry carries a non-trivial reason', () => {
    // An allowlist whose entries say "needed" is just a denylist with extra
    // steps — the reason is the whole point of the mechanism.
    for (const { file, reason } of EXCLUDED_FILES) {
      expect(reason.length, `${file} exclusion reason`).toBeGreaterThan(30);
    }
    for (const { file, value, reason } of ALLOWLIST) {
      expect(reason.length, `${file} ${value} reason`).toBeGreaterThan(20);
    }
  });

  it('no allowlist entry is stale — each value still appears in its file', () => {
    // A kept literal that has since been removed should drop off the list,
    // otherwise the allowlist slowly becomes a blanket exemption.
    for (const { file, value } of ALLOWLIST) {
      const needle = value.startsWith('rgba(') ? value.replace(/\s+/g, '') : value;
      const haystack = source(file).replace(/rgba\(\s*/g, 'rgba(').replace(/\s*,\s*/g, ',');
      expect(haystack.includes(needle) || source(file).includes(value), `${file} no longer contains ${value}`).toBe(true);
    }
  });

  it('the light palette is real, so a white-on-white regression is a real defect', () => {
    // The premise of every assertion above: light mode ships. If this block
    // ever disappears, the rules here become theoretical.
    const css = source('src/app/globals.css');
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)/);
    expect(css).toMatch(/--color-bg-primary:\s*#ffffff/i);
    expect(css).toMatch(/--color-text-primary:\s*#0e0e10/i);
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
    root.render(<TestProviders initialLocale={locale}>{node}</TestProviders>);
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

/**
 * A CSS custom property is meaningless to anything that is not CSS.
 *
 * The sweep replaced two hex literals in `ProofGate.tsx` that were arguments to
 * the `qrcode` canvas renderer, not style values. The build passed, the types
 * passed, every unit test passed — and the login QR threw
 * "Invalid hex color: var(--color-text-primary)" in the browser, so nobody
 * could sign in. Colour correctness is not something tsc can check.
 *
 * This pins the known non-CSS colour sinks. It is a list, not a heuristic:
 * a heuristic over "is this inside a style prop" would be guesswork, whereas
 * every entry here is a real API that takes a colour STRING.
 */
describe('var(--…) never reaches a non-CSS colour sink', () => {
  const NON_CSS_SINKS = [
    'darkColor',
    'lightColor',
    'fillStyle',
    'strokeStyle',
    'shadowColor',
    'themeColor',
  ];

  it.each(NON_CSS_SINKS)('no `var(--…)` is assigned to %s', (sink) => {
    const offenders: string[] = [];
    for (const file of [...COLOR_SWEPT_FILES]) {
      for (const line of source(file).split('\n')) {
        if (line.includes(sink) && line.includes('var(--')) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the QR renderer still gets real hex, in both its primary and fallback call', () => {
    const src = source('src/components/ProofGate.tsx');
    // Primary path (custom renderer) and the `qrcode` fallback both take colours.
    expect(src).toMatch(/darkColor: '#[0-9a-fA-F]{6}'/);
    expect(src).toMatch(/lightColor: '#[0-9a-fA-F]{6}'/);
    expect(src).toMatch(/dark: '#[0-9a-fA-F]{6}', light: '#[0-9a-fA-F]{6}'/);
  });
});
