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
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

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
  /** Fixed-height single row — see `compactContainer`. Used by chat, where a
   *  card that changes height drags the whole conversation with it. */
  compact?: boolean;
  /** Shown under the title when the fetch gave us no siteName. */
  host?: string;
  /** Shown as the title when there is no preview to show. */
  unavailableLabel?: string;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
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
      borderRadius: RADIUS.control,
      marginRight: 5,
    },
    siteName: {
      fontSize: TYPE_SCALE.label,
      color: colors.text.tertiary,
    },
    title: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.text.primary,
      lineHeight: 20,
      marginBottom: 2,
    },
    description: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.secondary,
      lineHeight: 17,
    },
    /*
     * COMPACT — one row, one height, every state.
     *
     * The full card's height depends on what came back (image / no image, one
     * title line or two), and in a chat list that means the conversation moves
     * when a preview resolves, and moves again if it fails. This variant is
     * fixed at COMPACT_HEIGHT from the first paint, so loading, resolved and
     * unavailable are three paints of the same box and nothing shifts.
     */
    compactContainer: {
      flexDirection: 'row',
      alignItems: 'stretch',
      height: COMPACT_HEIGHT,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.secondary,
      marginTop: 6,
      overflow: 'hidden',
    },
    compactThumb: {
      width: COMPACT_HEIGHT,
      height: '100%',
      backgroundColor: colors.background.tertiary,
    },
    compactBody: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 10,
      gap: 2,
    },
    image: {
      width: '100%',
      aspectRatio: 1.91,
      borderRadius: RADIUS.control,
      marginTop: 8,
      backgroundColor: colors.background.tertiary,
    },
  });
}

/** One row: a square thumbnail and two lines of text. */
export const COMPACT_HEIGHT = 72;

export function OGPreviewCard({ data, onPress, compact, host, unavailableLabel }: OGPreviewCardProps) {
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

  if (compact) {
    return (
      <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.75}>
        {showImage ? (
          <Image
            source={{ uri: data.image! }}
            style={styles.compactThumb}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
          />
        ) : null}
        <View style={styles.compactBody}>
          {/* Loading shows the box with no title; unavailable says so. Neither
              may leave a hole or remove the box — both would move the list. */}
          <Text style={styles.title} numberOfLines={2} ellipsizeMode="tail">
            {data.title ?? unavailableLabel ?? ''}
          </Text>
          <Text style={styles.siteName} numberOfLines={1} ellipsizeMode="tail">
            {data.siteName ?? host ?? ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

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
