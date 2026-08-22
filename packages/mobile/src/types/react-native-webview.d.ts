// Ambient declaration so the mini-app's standalone tsc can resolve
// `react-native-webview`, which is physically installed in the host
// (`proofport-app/node_modules/`) and surfaced via Metro at bundle time.
declare module 'react-native-webview' {
  import type { ComponentType, Ref } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  export interface WebViewNavigation {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  }

  /**
   * The imperative handle a `ref` on `<WebView>` yields.
   *
   * The upstream package declares the component as a bare
   * `React.FunctionComponent<WebViewProps>` with no ref type at all, so
   * `useRef<WebView>` does not compile against the real types either — the
   * component is a value, never a type. Only the commands this app actually
   * drives from the toolbar are listed; anything else fails here rather than
   * type-checking against a fiction.
   */
  export interface WebViewMethods {
    goBack(): void;
    goForward(): void;
    reload(): void;
    stopLoading(): void;
  }

  /** `event.nativeEvent.progress` is 0..1. */
  export interface WebViewProgressEvent {
    nativeEvent: { progress: number };
  }

  export interface WebViewProps {
    ref?: Ref<WebViewMethods>;
    source:
      | { uri: string; headers?: Record<string, string> }
      | { html: string; baseUrl?: string };
    originWhitelist?: string[];
    style?: StyleProp<ViewStyle>;
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onLoad?: () => void;
    onLoadProgress?: (event: WebViewProgressEvent) => void;
    onNavigationStateChange?: (navigation: WebViewNavigation) => void;
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
