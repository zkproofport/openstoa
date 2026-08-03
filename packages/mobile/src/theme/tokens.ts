/**
 * Typography + radius tokens for the OpenStoa mobile mini-app.
 *
 * Mirrors the web's scale in `src/styles/tokens.ts` (and the `--text-*` /
 * `--radius-*` custom properties in `src/app/globals.css`) so the two
 * clients of one product resolve to the same steps. Sits next to
 * `colors.ts`, which is the same mirror for the palette.
 *
 * Values are plain numbers because React Native styles take unitless
 * density-independent pixels — there is no `var()` indirection to defer to
 * the way the web has, so the constant IS the live value here.
 *
 * If you change a step, change it on the web in the same pass.
 */

// ── Typography — 7 steps, named by role.
//
// `label` (12) is the floor and is for short Latin/numeric chips and
// meta counts ONLY. Korean body copy must never sit below `bodySmall`
// (14) — Hangul syllable blocks carry more strokes per em than Latin
// glyphs and go unreadable first. Running prose (post bodies, chat
// messages, comment text) belongs at `body` (16) in both scripts.
export const TYPE_SCALE = {
  label: 12,
  caption: 13,
  bodySmall: 14,
  body: 16,
  bodyLarge: 18,
  headingSmall: 22,
  headingLarge: 32,
} as const;

// ── Radius — 4 steps.
//
// `pill` is 999 rather than "half the height" so a row can grow (longer
// Korean label, larger Dynamic Type) without the corner geometry drifting
// out of round. Avatars and chips use `pill`; anything that was written as
// `size / 2` is a pill, not a modal.
export const RADIUS = {
  control: 6, // input, chip background, inline button, small square avatar
  card: 12, // card, panel, sheet section
  modal: 16, // modal, bottom sheet, full-bleed overlay
  pill: 999, // fully-rounded: avatar, tag, toggle, badge
} as const;

// ── Touch target — iOS HIG / Material minimum. Any tappable row or icon
// button must reach this in BOTH axes, independent of its text size.
export const TOUCH_TARGET_MIN = 44;

export type TypeScaleStep = keyof typeof TYPE_SCALE;
export type RadiusStep = keyof typeof RADIUS;
