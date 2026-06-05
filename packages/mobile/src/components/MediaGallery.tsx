import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
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
   *  width inside the carousel. */
  horizontalPadding?: number;
  /** Optional handler fired when the user taps an image. Used by the feed
   *  PostCard so tapping any image in the carousel navigates to PostDetail
   *  (the carousel still pages horizontally on drag — paging vs tap is
   *  disambiguated by the gesture system). */
  onImagePress?: (index: number) => void;
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
    carousel: { position: 'relative' },
    galleryImage: {
      borderRadius: 10,
      backgroundColor: colors.background.tertiary,
    },
    pageIndicator: {
      position: 'absolute',
      top: 8,
      right: 8,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
    },
    pageIndicatorText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '600',
      fontVariantNumeric: 'tabular-nums',
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
    // Fullscreen lightbox (detail mode only). Tap anywhere to close.
    lightboxBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.95)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    lightboxCloseBtn: {
      position: 'absolute',
      top: 48,
      right: 16,
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1,
    },
    lightboxCloseLabel: {
      color: '#fff',
      fontSize: 22,
      fontWeight: '600',
      lineHeight: 22,
      marginTop: -2,
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
  onImagePress,
}: MediaGalleryProps) {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const itemWidth = Math.max(0, windowWidth - horizontalPadding);
  const imageHeight = Math.round(itemWidth * (10 / 16));

  const [activeIndex, setActiveIndex] = useState(0);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (itemWidth <= 0) return;
      const idx = Math.round(e.nativeEvent.contentOffset.x / itemWidth);
      if (idx !== activeIndex) setActiveIndex(idx);
    },
    [itemWidth, activeIndex],
  );

  // Lightbox state — only used in detail mode where the gallery owns
  // its own fullscreen viewer. In feed mode the parent handles taps
  // (typically navigating to PostDetail) via `onImagePress`.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  const parsedVideos = useMemo(
    () => (videos ?? []).map(parseVideo).filter((v): v is ParsedVideo => v !== null),
    [videos],
  );

  const hasImages = (images?.length ?? 0) > 0;
  const hasVideos = parsedVideos.length > 0;
  if (!hasImages && !hasVideos) return null;

  // Tap handler: feed mode delegates to parent (navigate to PostDetail);
  // detail mode opens the local fullscreen lightbox.
  const handleImageTap = (i: number) => {
    if (onImagePress) {
      onImagePress(i);
    } else if (mode === 'detail') {
      setLightboxIndex(i);
    }
  };

  return (
    <View style={styles.wrap}>
      {hasImages ? (
        <View style={styles.carousel}>
          {/* Horizontal ScrollView (not FlatList) — when this carousel sits
              inside another vertical FlatList (the post feed), nested
              VirtualizedLists swallowed pan gestures on iOS so swipe stopped
              working. ScrollView with pagingEnabled is the recommended
              pattern for short, eagerly-loaded carousels and restores the
              previous swipe behaviour. */}
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            // Decelerate fast so paging snaps cleanly between full-width
            // images instead of drifting onto the next image.
            decelerationRate="fast"
            // Allow nested scrolling so the parent vertical FlatList
            // (post feed) doesn't intercept horizontal pan gestures.
            nestedScrollEnabled
            // Keep all images mounted; this is a small carousel so the
            // memory cost is negligible and we avoid the placeholder flash
            // FlatList shows on first swipe. Also prevents the parent
            // FlatList from clipping mid-swipe frames.
            removeClippedSubviews={false}
          >
            {(images ?? []).map((uri, i) => {
              // Fixed-width wrapper ensures pagingEnabled snaps cleanly
              // regardless of the image's intrinsic size. Pressable's
              // onPress fires only on tap-up without significant pan, so
              // horizontal drag still reaches the ScrollView's gesture
              // handler. Tap routes via handleImageTap → either parent
              // (feed mode) or local lightbox (detail mode).
              return (
                <View key={`${uri}-${i}`} style={{ width: itemWidth }}>
                  <Pressable onPress={() => handleImageTap(i)}>
                    <Image
                      source={{ uri }}
                      style={[
                        styles.galleryImage,
                        { width: itemWidth, height: imageHeight },
                      ]}
                      resizeMode="cover"
                    />
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
          {(images?.length ?? 0) > 1 ? (
            <>
              {/* "1/3" page counter — pinned to the top-right of the
                  carousel so the user can see at a glance how many images
                  the post has and where they are in the set. */}
              <View style={styles.pageIndicator}>
                <Text style={styles.pageIndicatorText}>
                  {activeIndex + 1}/{images!.length}
                </Text>
              </View>
              <View style={styles.dotsRow}>
                {images!.map((_, i) => (
                  <View
                    key={i}
                    style={[styles.dot, i === activeIndex ? styles.dotActive : null]}
                  />
                ))}
              </View>
            </>
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

      {/* Fullscreen lightbox — detail mode only. Tap backdrop or × to
          close. The image is letterboxed (resizeMode="contain") so wide
          and tall images both fit inside the viewport. */}
      {lightboxIndex !== null && images && images[lightboxIndex] ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={closeLightbox}
        >
          <StatusBar barStyle="light-content" />
          <TouchableWithoutFeedback onPress={closeLightbox}>
            <View style={styles.lightboxBackdrop}>
              <TouchableOpacity
                style={styles.lightboxCloseBtn}
                onPress={closeLightbox}
                accessibilityLabel="Close"
              >
                <Text style={styles.lightboxCloseLabel}>×</Text>
              </TouchableOpacity>
              <View pointerEvents="none">
                <Image
                  source={{ uri: images[lightboxIndex] }}
                  style={{ width: windowWidth, height: windowHeight - 80 }}
                  resizeMode="contain"
                />
              </View>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      ) : null}
    </View>
  );
}
