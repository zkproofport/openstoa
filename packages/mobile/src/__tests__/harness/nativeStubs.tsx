/**
 * Stand-ins for the two native modules that have no JavaScript to run (T-1).
 *
 * The rule this file obeys, and the reason it is this short: EVERYTHING THAT
 * CAN BE REAL IS REAL. `@tanstack/react-query`, `zustand`, `i18next`,
 * `react-i18next`, `react-native-sse` and `@react-navigation/*` are the actual
 * packages in these tests, because a screen mounted against fakes tests the
 * fakes. What is left here is the surface that genuinely cannot execute off a
 * device: an SVG renderer that draws into native views, and an icon font.
 *
 * Both are rendered as named host elements keeping their props, so a test can
 * still assert that an icon was asked for — the information a test wants from
 * an icon is its name, not its glyph.
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function host(name: string) {
  const Component = (props: AnyProps) => React.createElement(name, props, props.children);
  Component.displayName = name;
  return Component;
}

/**
 * `react-native-svg`. Named exports only — the same "fails loudly at import"
 * rule as the react-native stand-in, so a component reaching for a shape that
 * is not here says so rather than rendering nothing.
 */
export const Svg = host('Svg');
export const Path = host('Path');
export const Circle = host('Circle');
export const Rect = host('Rect');
export const G = host('G');
export const Line = host('Line');
export const Defs = host('Defs');
export const ClipPath = host('ClipPath');
export const LinearGradient = host('LinearGradient');
export const Stop = host('Stop');
export const Polygon = host('Polygon');
export const Ellipse = host('Ellipse');
/** SVG's own `Text`, deliberately a DIFFERENT host name from react-native's. */
export const Text = host('SvgText');
export default Svg;
