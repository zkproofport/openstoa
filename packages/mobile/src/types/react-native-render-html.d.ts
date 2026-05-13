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
    source: { html: string } | { uri: string };
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
