import React, { useState } from 'react';
import { Dimensions, View } from 'react-native';
import WebView from 'react-native-webview';
import YoutubePlayer from 'react-native-youtube-iframe';
import { useThemeColors } from '../theme/ThemeContext';

export interface VideoEmbedProps {
  type: 'youtube' | 'vimeo';
  /** YouTube 11-char videoId or Vimeo numeric id. */
  videoId: string;
}

/**
 * Inline playable video card.
 *
 * - YouTube: uses `react-native-youtube-iframe`, which wraps the YouTube
 *   IFrame Player API correctly (postMessage handshake, origin handling) so
 *   videos play without the 152/153 "player configuration" errors that
 *   plain WebView embeds hit on iOS.
 * - Vimeo: a standard WebView pointed at Vimeo's player URL, which doesn't
 *   require the same referer dance.
 */
export function VideoEmbed({ type, videoId }: VideoEmbedProps) {
  const { colors } = useThemeColors();
  // Default to full viewport width; the host card provides horizontal
  // padding, but the player needs a concrete width to size the iframe.
  const [containerWidth, setContainerWidth] = useState(
    Dimensions.get('window').width - 32,
  );

  const height = Math.round(containerWidth * (9 / 16));

  if (type === 'youtube') {
    return (
      <View
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        style={{
          width: '100%',
          borderRadius: 10,
          overflow: 'hidden',
          backgroundColor: colors.background.tertiary,
        }}
      >
        <YoutubePlayer
          height={height}
          width={containerWidth}
          videoId={videoId}
          play={false}
          webViewProps={{
            allowsInlineMediaPlayback: true,
            mediaPlaybackRequiresUserAction: true,
          }}
        />
      </View>
    );
  }

  // Vimeo — its player URL works in a plain WebView.
  return (
    <View
      style={{
        width: '100%',
        aspectRatio: 16 / 9,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: colors.background.tertiary,
      }}
    >
      <WebView
        source={{ uri: `https://player.vimeo.com/video/${videoId}` }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction
        androidLayerType="hardware"
        startInLoadingState
      />
    </View>
  );
}
