// Ambient declaration so the mini-app's standalone tsc can resolve
// `react-native-webview`, which is physically installed in the host
// (`proofport-app/node_modules/`) and surfaced via Metro at bundle time.
declare module 'react-native-webview' {
  import type { ComponentType } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  export interface WebViewNavigation {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  }

  export interface WebViewProps {
    source:
      | { uri: string; headers?: Record<string, string> }
      | { html: string; baseUrl?: string };
    originWhitelist?: string[];
    style?: StyleProp<ViewStyle>;
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onLoad?: () => void;
    onError?: (event: { nativeEvent: { description: string } }) => void;
    onShouldStartLoadWithRequest?: (request: { url: string }) => boolean;
    javaScriptEnabled?: boolean;
    domStorageEnabled?: boolean;
    startInLoadingState?: boolean;
    scalesPageToFit?: boolean;
    allowsInlineMediaPlayback?: boolean;
    allowsFullscreenVideo?: boolean;
    mediaPlaybackRequiresUserAction?: boolean;
    androidLayerType?: 'none' | 'software' | 'hardware';
  }

  const WebView: ComponentType<WebViewProps>;
  export default WebView;
}
