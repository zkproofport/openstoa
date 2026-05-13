import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import WebView from 'react-native-webview';
import { useThemeColors } from '../../theme/ThemeContext';

export type InAppBrowserRouteParams = {
  url: string;
  title?: string;
};

export function InAppBrowserScreen() {
  const route = useRoute<any>();
  const { url } = route.params as InAppBrowserRouteParams;
  const { colors } = useThemeColors();
  const [loading, setLoading] = useState(true);

  return (
    <View style={styles.container}>
      <WebView
        source={{ uri: url }}
        style={styles.webview}
        onLoadEnd={() => setLoading(false)}
        onShouldStartLoadWithRequest={() => true}
        javaScriptEnabled
        domStorageEnabled
      />
      {loading ? (
        <View style={[styles.loadingOverlay, { backgroundColor: colors.background.primary }]}>
          <ActivityIndicator size="large" color={colors.brand.primary} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
