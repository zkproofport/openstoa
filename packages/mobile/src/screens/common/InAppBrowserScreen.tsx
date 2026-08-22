import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Share,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import type { WebViewNavigation, WebViewMethods, WebViewProgressEvent } from 'react-native-webview';
import Feather from 'react-native-vector-icons/Feather';
import { useThemeColors } from '../../theme/ThemeContext';

export type InAppBrowserRouteParams = {
  url: string;
  title?: string;
};

export function InAppBrowserScreen() {
  const route = useRoute<any>();
  const { url } = route.params as InAppBrowserRouteParams;
  const { colors } = useThemeColors();
  const [progress, setProgress] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url);
  // `WebView` is a value, not a type — the ref yields the imperative
  // command handle (`goBack`/`goForward`/`reload`), not the component.
  const webViewRef = useRef<WebViewMethods | null>(null);
  const progressOpacity = useRef(new Animated.Value(0)).current;

  const onLoadProgress = useCallback((event: WebViewProgressEvent) => {
    setProgress(event.nativeEvent.progress);
  }, []);

  const onLoadStart = useCallback(() => {
    progressOpacity.setValue(1);
  }, [progressOpacity]);

  const onLoadEnd = useCallback(() => {
    // Fade out the progress bar after the page finishes — matches Safari.
    Animated.timing(progressOpacity, {
      toValue: 0,
      duration: 250,
      delay: 200,
      useNativeDriver: true,
    }).start(() => setProgress(0));
  }, [progressOpacity]);

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
    setCanGoForward(nav.canGoForward);
    setCurrentUrl(nav.url);
  }, []);

  const goBack = useCallback(() => webViewRef.current?.goBack(), []);
  const goForward = useCallback(() => webViewRef.current?.goForward(), []);
  const reload = useCallback(() => webViewRef.current?.reload(), []);
  const share = useCallback(async () => {
    try {
      // iOS needs `url` only — passing both makes the share sheet show
      // "2 links". Android only respects `message`.
      await Share.share(
        Platform.OS === 'ios' ? { url: currentUrl } : { message: currentUrl },
      );
    } catch {
      // user dismissed
    }
  }, [currentUrl]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background.primary }]}>
      <Animated.View
        style={[
          styles.progressTrack,
          { opacity: progressOpacity, backgroundColor: 'transparent' },
        ]}
      >
        <View
          style={{
            height: 2,
            width: `${progress * 100}%`,
            backgroundColor: colors.brand.primary,
          }}
        />
      </Animated.View>
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={styles.webview}
        onLoadStart={onLoadStart}
        onLoadEnd={onLoadEnd}
        onLoadProgress={onLoadProgress}
        onNavigationStateChange={onNavigationStateChange}
        javaScriptEnabled
        domStorageEnabled
      />
      <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.background.primary }}>
        <View style={[styles.toolbar, { borderTopColor: colors.border.default }]}>
          <ToolbarBtn icon="chevron-left" disabled={!canGoBack} onPress={goBack} color={colors.brand.primary} dim={colors.text.tertiary} />
          <ToolbarBtn icon="chevron-right" disabled={!canGoForward} onPress={goForward} color={colors.brand.primary} dim={colors.text.tertiary} />
          <ToolbarBtn icon="rotate-cw" onPress={reload} color={colors.brand.primary} dim={colors.text.tertiary} />
          <ToolbarBtn icon="share" onPress={share} color={colors.brand.primary} dim={colors.text.tertiary} />
        </View>
      </SafeAreaView>
    </View>
  );
}

function ToolbarBtn({ icon, disabled, onPress, color, dim }: {
  icon: string;
  disabled?: boolean;
  onPress: () => void;
  color: string;
  dim: string;
}) {
  return (
    <TouchableOpacity
      style={styles.toolbarBtn}
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Feather name={icon} size={22} color={disabled ? dim : color} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  progressTrack: {
    height: 2,
    width: '100%',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolbarBtn: {
    paddingHorizontal: 18,
    paddingVertical: 6,
  },
});
