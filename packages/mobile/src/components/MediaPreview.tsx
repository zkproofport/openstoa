import React from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import type { PostMedia } from '@openstoa/api-types';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { VideoEmbed } from './VideoEmbed';
import { RADIUS } from '../theme/tokens';

export interface MediaPreviewProps {
  media: PostMedia | null | undefined;
  /** Image strip height in horizontal mode. Defaults to 200. */
  imageHeight?: number;
  /** Image strip item width in horizontal mode. Defaults to 280. */
  imageWidth?: number;
  /** When true, render images full-width stacked (detail view). When false,
   *  use horizontal scroll strip (feed preview). */
  fullWidth?: boolean;
}

interface ParsedVideo {
  type: 'youtube' | 'vimeo';
  videoId: string;
}

const YT_PATTERNS = [
  /(?:youtube\.com\/watch\?[^\s]*v=)([a-zA-Z0-9_-]{11})/,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
];
const VIMEO_PATTERN = /vimeo\.com\/(\d+)/;

function parseVideo(url: string): ParsedVideo | null {
  for (const re of YT_PATTERNS) {
    const m = re.exec(url);
    if (m) return { type: 'youtube', videoId: m[1] };
  }
  const vm = VIMEO_PATTERN.exec(url);
  if (vm) return { type: 'vimeo', videoId: vm[1] };
  return null;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    section: { marginTop: 8 },
    imageStripContent: { paddingRight: 8 },
    image: {
      borderRadius: RADIUS.card,
      marginRight: 8,
      backgroundColor: colors.background.tertiary,
    },
    fullImage: {
      width: '100%',
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.tertiary,
      marginBottom: 8,
      aspectRatio: 16 / 10,
    },
    videosWrap: {
      marginTop: 8,
      gap: 12,
    },
  });
}

/**
 * Renders a post's attached media (`post.media`). Images render as either a
 * horizontal-scroll strip (compact / feed) or a full-width vertical stack
 * (detail). Videos render as fully playable YouTube/Vimeo embeds, matching
 * the mobile detail view.
 *
 * Legacy posts may have no media at all (URLs/img tags embedded in `content`
 * itself); the caller is responsible for the legacy content-extraction path.
 */
export function MediaPreview({ media, imageHeight = 200, imageWidth = 280, fullWidth }: MediaPreviewProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);

  if (!media) return null;

  const images = media.images ?? [];
  const videos = (media.videos ?? [])
    .map((u) => ({ url: u, parsed: parseVideo(u) }))
    .filter((v): v is { url: string; parsed: ParsedVideo } => v.parsed !== null);

  if (images.length === 0 && videos.length === 0) return null;

  return (
    <View style={styles.section}>
      {images.length > 0 ? (
        fullWidth ? (
          <View>
            {images.map((uri, i) => (
              <Image
                key={`${uri}-${i}`}
                source={{ uri }}
                style={styles.fullImage}
                resizeMode="cover"
              />
            ))}
          </View>
        ) : (
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
        )
      ) : null}
      {videos.length > 0 ? (
        <View style={styles.videosWrap}>
          {videos.map((v) => (
            <VideoEmbed key={v.url} type={v.parsed.type} videoId={v.parsed.videoId} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
