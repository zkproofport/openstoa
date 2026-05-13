import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';
import { VideoEmbed } from './VideoEmbed';

export interface MediaGalleryProps {
  images?: string[];
  videos?: string[];
  /** `feed` shows a thumbnail-style gallery with the first video only plus
   *  a "+N" badge for any extra videos; `detail` plays every video inline. */
  mode?: 'feed' | 'detail';
  /** Horizontal padding the parent applies — used to compute the image
   *  width inside the FlatList. */
  horizontalPadding?: number;
}

interface ParsedVideo {
  type: 'youtube' | 'vimeo';
  videoId: string;
  url: string;
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
    if (m) return { type: 'youtube', videoId: m[1], url };
  }
  const vm = VIMEO_PATTERN.exec(url);
  if (vm) return { type: 'vimeo', videoId: vm[1], url };
  return null;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { marginTop: 8, marginBottom: 8 },
    galleryImage: {
      borderRadius: 10,
      backgroundColor: colors.background.tertiary,
    },
    dotsRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.text.tertiary,
      opacity: 0.4,
    },
    dotActive: { opacity: 1, backgroundColor: colors.brand.primary },
    videoBlock: { marginTop: 10 },
    videoWithBadge: { position: 'relative' },
    moreVideosBadge: {
      position: 'absolute',
      top: 8,
      right: 8,
      backgroundColor: 'rgba(0,0,0,0.7)',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
    },
    moreVideosText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '700',
    },
  });
}

/**
 * Unified media renderer for post images + videos. Mirrors the visual
 * model the user picked (Twitter/X): a swipeable image carousel followed
 * by inline video cards. The `feed` mode only mounts the first video and
 * shows a "+N" badge for the rest — keeps long lists snappy.
 */
export function MediaGallery({
  images,
  videos,
  mode = 'detail',
  horizontalPadding = 32,
}: MediaGalleryProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { width: windowWidth } = useWindowDimensions();

  const itemWidth = Math.max(0, windowWidth - horizontalPadding);
  const imageHeight = Math.round(itemWidth * (10 / 16));

  const [activeIndex, setActiveIndex] = useState(0);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / itemWidth);
      if (idx !== activeIndex) setActiveIndex(idx);
    },
    [itemWidth, activeIndex],
  );

  const parsedVideos = useMemo(
    () => (videos ?? []).map(parseVideo).filter((v): v is ParsedVideo => v !== null),
    [videos],
  );

  const hasImages = (images?.length ?? 0) > 0;
  const hasVideos = parsedVideos.length > 0;
  if (!hasImages && !hasVideos) return null;

  return (
    <View style={styles.wrap}>
      {hasImages ? (
        <View>
          <FlatList
            data={images ?? []}
            keyExtractor={(item, i) => `${item}-${i}`}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            renderItem={({ item }) => (
              <Image
                source={{ uri: item }}
                style={[
                  styles.galleryImage,
                  { width: itemWidth, height: imageHeight },
                ]}
                resizeMode="cover"
              />
            )}
          />
          {(images?.length ?? 0) > 1 ? (
            <View style={styles.dotsRow}>
              {images!.map((_, i) => (
                <View
                  key={i}
                  style={[styles.dot, i === activeIndex ? styles.dotActive : null]}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {hasVideos ? (
        mode === 'feed' ? (
          <View style={[styles.videoBlock, styles.videoWithBadge]}>
            <VideoEmbed type={parsedVideos[0].type} videoId={parsedVideos[0].videoId} />
            {parsedVideos.length > 1 ? (
              <View style={styles.moreVideosBadge}>
                <Text style={styles.moreVideosText}>+{parsedVideos.length - 1}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          parsedVideos.map((v) => (
            <View key={v.url} style={styles.videoBlock}>
              <VideoEmbed type={v.type} videoId={v.videoId} />
            </View>
          ))
        )
      ) : null}
    </View>
  );
}
