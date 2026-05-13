import React, { useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  favicon: string | null;
}

interface OGPreviewCardProps {
  url: string;
  data: OGData;
  onPress: () => void;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      padding: 12,
      backgroundColor: colors.background.secondary,
      marginTop: 6,
    },
    siteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    favicon: {
      width: 14,
      height: 14,
      borderRadius: 2,
      marginRight: 5,
    },
    siteName: {
      fontSize: 11,
      color: colors.text.tertiary,
    },
    title: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text.primary,
      lineHeight: 20,
      marginBottom: 2,
    },
    description: {
      fontSize: 12,
      color: colors.text.secondary,
      lineHeight: 17,
    },
    image: {
      width: '100%',
      aspectRatio: 1.91,
      borderRadius: 4,
      marginTop: 8,
      backgroundColor: colors.background.tertiary,
    },
  });
}

export function OGPreviewCard({ data, onPress }: OGPreviewCardProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  // Track image-load failure so we can collapse the (otherwise empty)
  // grey image placeholder. Same for the tiny favicon. The image proxy
  // already protects us from most upstream-CDN flakiness, but if it
  // still fails (e.g. upstream returns non-image or 502) we want the
  // card to compact down rather than leave a blank rectangle.
  const [imageFailed, setImageFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  const showFavicon = !!data.favicon && !faviconFailed;
  const showImage = !!data.image && !imageFailed;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {(showFavicon || data.siteName) ? (
        <View style={styles.siteRow}>
          {showFavicon ? (
            <Image
              source={{ uri: data.favicon! }}
              style={styles.favicon}
              resizeMode="contain"
              onError={() => setFaviconFailed(true)}
            />
          ) : null}
          {data.siteName ? (
            <Text style={styles.siteName} numberOfLines={1}>
              {data.siteName}
            </Text>
          ) : null}
        </View>
      ) : null}

      {data.title ? (
        <Text style={styles.title} numberOfLines={2} ellipsizeMode="tail">
          {data.title}
        </Text>
      ) : null}

      {data.description ? (
        <Text style={styles.description} numberOfLines={1} ellipsizeMode="tail">
          {data.description}
        </Text>
      ) : null}

      {showImage ? (
        <Image
          source={{ uri: data.image! }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImageFailed(true)}
        />
      ) : null}
    </TouchableOpacity>
  );
}
