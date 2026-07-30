/**
 * Design tokens — typed mirror of the CSS custom properties defined in
 * `src/app/globals.css`. Use this module when a raw JS/TS value is required
 * (canvas/SVG fills, computed layout math, `window.matchMedia` queries) where
 * a CSS `var(--...)` string cannot be used. Everywhere else, prefer the CSS
 * custom properties directly (`var(--color-bg-primary)`, etc.) so the value
 * stays live across the light/dark + override cascade.
 *
 * Color values mirror `packages/mobile/src/theme/colors.ts` exactly — the web
 * and mobile clients are one product and must resolve to the same grounds.
 * If you change a color here, change it in both places and in globals.css.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeColors {
  background: { primary: string; secondary: string; tertiary: string };
  text: { primary: string; secondary: string; tertiary: string; inverted: string };
  brand: { primary: string; primaryHover: string; primaryMuted: string; accent: string };
  border: { default: string; strong: string };
  status: { success: string; warning: string; danger: string };
}

// Keep byte-for-byte in sync with packages/mobile/src/theme/colors.ts
// (brand.primaryHover is web-only — mobile has no hover state).
export const lightColors: ThemeColors = {
  background: { primary: '#FFFFFF', secondary: '#F5F5F7', tertiary: '#EEEEF2' },
  text: { primary: '#0E0E10', secondary: '#5C5C66', tertiary: '#9A9AA1', inverted: '#FFFFFF' },
  brand: { primary: '#5B49E8', primaryHover: '#4A3AC7', primaryMuted: '#EAE6FB', accent: '#11C28A' },
  border: { default: '#E2E2E8', strong: '#C8C8D0' },
  status: { success: '#11C28A', warning: '#F0A619', danger: '#E5484D' },
};

export const darkColors: ThemeColors = {
  background: { primary: '#0E0E10', secondary: '#17171B', tertiary: '#1F1F25' },
  text: { primary: '#F5F5F7', secondary: '#A0A0AB', tertiary: '#6E6E78', inverted: '#0E0E10' },
  brand: { primary: '#7C6BFF', primaryHover: '#9384FF', primaryMuted: '#28244C', accent: '#22D3A2' },
  border: { default: '#2A2A33', strong: '#3A3A45' },
  status: { success: '#22D3A2', warning: '#F0A619', danger: '#FF6369' },
};

export function getThemeColors(mode: ThemeMode): ThemeColors {
  return mode === 'dark' ? darkColors : lightColors;
}

/**
 * Role separation (do NOT interchange):
 * - brand.accent  = verified / encrypted (green)
 * - brand.primary = action / link / focus (indigo)
 * - status.danger = danger (red)
 */
export const ROLE_COLOR_NOTE =
  'brand.accent=verified/encrypted, brand.primary=action/link/focus, status.danger=danger';

// ── Typography — 7 steps, named by role. Mirrors `--text-*` in globals.css.
// `label` (12px) is reserved for uppercase Latin labels ONLY — never Korean
// or running body copy. `body` (16px) is the Korean/long-form prose floor
// and also satisfies the iOS Safari "inputs <16px zoom on focus" rule.
export const TYPE_SCALE = {
  label: 12, // uppercase Latin labels only (e.g. section headings, badges)
  caption: 13, // meta text: timestamps, counts
  bodySmall: 14, // default UI text: buttons, nav items
  body: 16, // body copy floor — required for Korean, and for form inputs
  bodyLarge: 18, // emphasized body / lead paragraph
  headingSmall: 22, // card/section headings
  headingLarge: 32, // page headings / hero
} as const;

// ── Spacing — 4 / 8 / 12 / 16 / 24 / 32 / 48
export const SPACING = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
} as const;

// ── Radius — 4 steps
export const RADIUS = {
  control: 6, // small control: input, chip, inline button
  card: 12, // card, panel
  modal: 16, // modal, sheet
  pill: 999, // pill, avatar, fully-rounded
} as const;

// ── Breakpoints — named, 2 cut points define 3 ranges.
// Both numbers match queries that are already load-bearing in the app rather
// than being invented here:
//   mobileMax  767 — the phone cut. `MOBILE_QUERY` in `src/hooks/useMediaQuery.ts`,
//                    the off-canvas drawer in `CommunityLayout.tsx`, the header
//                    collapse in `Header.tsx`, and `BottomTabBar` all use it.
//                    It was 640 here while every one of those used 767, so
//                    anything built on this constant would have left 641-767px
//                    with no navigation at all — the drawer hidden and the tab
//                    bar not yet shown. `SNSContent.tsx` has its own 640px cut,
//                    but that is one component reflowing its own content, not
//                    the app's phone breakpoint.
//   desktopMin 1024 — `DESKTOP_CHAT_QUERY`, which gates ChatPanel mounting.
export const BREAKPOINTS = {
  mobileMax: 767,
  tabletMax: 1023,
  desktopMin: 1024,
} as const;

export const MEDIA_QUERIES = {
  mobile: `(max-width: ${BREAKPOINTS.mobileMax}px)`,
  tablet: `(min-width: ${BREAKPOINTS.mobileMax + 1}px) and (max-width: ${BREAKPOINTS.tabletMax}px)`,
  desktop: `(min-width: ${BREAKPOINTS.desktopMin}px)`,
} as const;

// ── Touch target
export const TOUCH_TARGET_MIN = 44;
