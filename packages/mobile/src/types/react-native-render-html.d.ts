// Ambient declaration so the mini-app's standalone tsc can resolve
// `react-native-render-html`, which is physically installed in the host
// (`proofport-app/node_modules/`) and surfaced via Metro at bundle time.
// Only the surface we actually use is typed — the upstream package ships
// its own full .d.ts inside `lib/typescript/` for runtime/Metro consumers.
declare module 'react-native-render-html' {
  import type { ComponentType } from 'react';
  import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

  export interface RenderHtmlProps {
    contentWidth?: number;
    // `baseUrl` resolves relative `src`/`href` attributes (our own
    // `/api/media/...` image URLs) against the app's origin — verified
    // against the real installed package (`IMGRenderer.tsx` /
    // `useNormalizedUrl.ts`, v6.3.4 in `proofport-app/node_modules/`),
    // not just its docs.
    source: { html: string; baseUrl?: string } | { uri: string; baseUrl?: string };
    baseStyle?: StyleProp<TextStyle>;
    tagsStyles?: Record<string, StyleProp<TextStyle | ViewStyle>>;
    renderersProps?: Record<string, unknown>;
    systemFonts?: string[];
    ignoredDomTags?: string[];
    defaultTextProps?: Record<string, unknown>;
  }

  const RenderHtml: ComponentType<RenderHtmlProps>;
  export default RenderHtml;
  export const defaultSystemFonts: string[];
}
