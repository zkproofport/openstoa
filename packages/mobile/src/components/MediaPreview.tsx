import React from 'react';
import { Image, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { PostMedia } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface MediaPreviewProps {
  media: PostMedia | null | undefined;
  /** Image strip height. Defaults to 200 (preview), use 160 for full detail. */
  imageHeight?: number;
  /** Image strip item width. Defaults to 280 (preview), use 240 for full detail. */
  imageWidth?: number;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    section: {
      marginTop: 8,
    },
    imageStripContent: {
      paddingRight: 8,
    },
    image: {
      borderRadius: 10,
      marginRight: 8,
      backgroundColor: colors.background.tertiary,
    },
    embedCard: {
      marginTop: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      backgroundColor: colors.background.secondary,
    },
    embedType: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.text.tertiary,
    },
    embedUrl: {
      fontSize: 13,
      color: colors.brand.primary,
      marginTop: 2,
    },
  });
}

/**
 * Reusable media preview block. Shows a horizontal-scroll image strip plus
 * tappable cards for any embeds. Used by both PostCard (compact preview)
 * and PostDetailScreen (full detail).
 */
export function MediaPreview({ media, imageHeight = 200, imageWidth = 280 }: MediaPreviewProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  if (!media) return null;

  const images = media.images ?? [];
  const embeds = media.embeds ?? [];

  if (images.length === 0 && embeds.length === 0) return null;

  return (
    <View style={styles.section}>
      {images.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.imageStripContent}
        >
          {images.map((uri, i) => (
            <Image
              key={`${uri}-${i}`}
              source={{ uri }}
              style={[styles.image, { width: imageWidth, height: imageHeight }]}
              resizeMode="cover"
            />
          ))}
        </ScrollView>
      ) : null}
      {embeds.map((embed, i) => (
        <TouchableOpacity
          key={`${embed.url}-${i}`}
          style={styles.embedCard}
          activeOpacity={0.75}
          onPress={() => {
            void Linking.openURL(embed.url);
          }}
        >
          <Text style={styles.embedType}>{embed.type.toUpperCase()}</Text>
          <Text style={styles.embedUrl} numberOfLines={1}>
            {embed.url}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
