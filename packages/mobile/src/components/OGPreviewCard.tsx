import React, { useEffect, useState } from 'react';
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
import { probeImageSize } from './ChatImage';

/**
 * The shape the preview frame is drawn at — the aspect `og:image` is authored
 * for, and what every messenger reserves.
 */
const OG_FRAME_ASPECT = 1.91;

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
  /** The domain, shown on the card's last line the way a messenger does. */
  host?: string;
  /** No answer yet — draw the same card with grey bars where the text goes. */
  loading?: boolean;
  /** Long-press — the card carries the message, so it opens the copy sheet. */
  onLongPress?: () => void;
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
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: RADIUS.card,
      backgroundColor: colors.background.secondary,
      marginTop: 6,
      overflow: 'hidden',
    },
    compactImage: {
      width: '100%',
      // 1.91:1 — the aspect `og:image` is authored for.
      aspectRatio: 1.91,
      backgroundColor: colors.background.tertiary,
    },
    compactBody: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 3,
    },
    compactDomain: {
      fontSize: TYPE_SCALE.label,
      color: colors.brand.primary,
    },
    compactBar: {
      height: 11,
      borderRadius: RADIUS.control,
      backgroundColor: colors.background.tertiary,
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

export function OGPreviewCard({ data, onPress, compact, host, loading, onLongPress }: OGPreviewCardProps) {
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

  /*
   * Does this picture have to be shown WHOLE rather than filling the frame?
   *
   * A wide photo cropped to the frame looks like a photo. A square logo cropped
   * to the frame looks broken — the Ceph mark lost its top and bottom while the
   * same link in KakaoTalk showed it complete. Undefined until measured, and
   * `cover` until then: filling is right for the common case, and a card that
   * waits for a measurement before drawing anything is a card that flickers.
   */
  const [fitsWhole, setFitsWhole] = useState(false);
  useEffect(() => {
    if (!showImage || !data.image) return;
    let alive = true;
    void probeImageSize(data.image).then((size) => {
      // Unmounted mid-probe, or a file whose size cannot be read: leave the
      // default. Never a guess from the URL — plenty of logos end in `.jpg`.
      if (!alive || !size || size.width <= 0 || size.height <= 0) return;
      setFitsWhole(size.width / size.height < OG_FRAME_ASPECT);
    });
    return () => {
      alive = false;
    };
  }, [showImage, data.image]);

  if (compact) {
    return (
      <TouchableOpacity
        style={styles.compactContainer}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={400}
        activeOpacity={0.75}
      >
        {/*
          RESERVED WHILE LOADING, then kept or dropped once the answer is in.
          Three states, and each one is a deliberate trade:

          - loading: the space is held. Most links have a picture, so holding it
            is the guess that moves the conversation least — and not holding it
            was a regression. This card used to be one height in every state;
            when the empty-rectangle fix below landed, the image became
            conditional and the fixed height went with it, while the comment
            still described the old rule. What the sender saw was a short grey
            box that suddenly grew.
          - resolved WITH a picture: same height as the loading state, so
            nothing moves at the moment it arrives.
          - resolved WITHOUT one: dropped. Reserving it forever left a large
            empty rectangle that reads as a picture which failed to load, on
            every card for a page with no `og:image`. KakaoTalk drops it too.
            This is the one state that changes height, and it changes once.

          A LOGO IS NOT A PHOTO. Filling the frame beheaded the Ceph logo — a
          square image cropped to 1.91:1 loses two thirds of its height — while
          the same link in KakaoTalk showed it whole. A picture wider than the
          frame fills it; anything squarer or taller is fitted inside instead.
          The measurement is the image's own, never a guess from the filename.
        */}
        {loading && !showImage ? (
          <View style={styles.compactImage} />
        ) : showImage ? (
          <Image
            source={{ uri: data.image! }}
            style={styles.compactImage}
            resizeMode={fitsWhole ? 'contain' : 'cover'}
            onError={() => setImageFailed(true)}
          />
        ) : null}
        <View style={styles.compactBody}>
          {loading ? (
            <>
              <View style={[styles.compactBar, { width: '70%' }]} />
              <View style={[styles.compactBar, { width: '90%' }]} />
              <View style={[styles.compactBar, { width: '35%' }]} />
            </>
          ) : (
            <>
              <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
                {data.title ?? host ?? ''}
              </Text>
              {/* Two lines are reserved either way, so a site with no
                  description makes the same card as one that has it. */}
              <Text style={styles.description} numberOfLines={2} ellipsizeMode="tail">
                {data.description ?? ''}
              </Text>
              <Text style={styles.compactDomain} numberOfLines={1} ellipsizeMode="tail">
                {host ?? ''}
              </Text>
            </>
          )}
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
