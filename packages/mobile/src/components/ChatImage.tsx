import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { chatMediaBox, type ChatMediaBox } from '../lib/chatMediaLayout';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';

/**
 * A picture in a chat bubble — the mini-app half of the pair.
 *
 * The web twin is `src/components/ChatImage.tsx`. Neither holds the rule: both
 * call `chatMediaBox` in `@openstoa/mls`, so "the two clients reach the same
 * visual decision" is a property of one shared function rather than of two
 * implementations that happen to agree this week.
 *
 * What this replaces: a hard 220x220 with `resizeMode="cover"`. That did bound
 * the height, but it center-cropped every ordinary landscape photo to a square
 * to get there — a 4:3 holiday photo lost a quarter of itself to a rule aimed
 * at screenshots.
 */

/** Picture width in a bubble. The web uses the same number for a normal column. */
export const CHAT_IMAGE_SLOT_WIDTH = 240;

export interface ChatImageNaturalSize {
  width: number;
  height: number;
}

/**
 * Read a picture's intrinsic size without putting it in the layout.
 *
 * Never rejects, and the render is never GATED on it: a file that cannot be
 * read resolves to `null`, and the shared rule turns that into the reserved
 * square. `Image.getSize` is the only way to learn this on the device — the
 * envelope carries no dimensions. See the web twin for why awaiting this
 * before showing the picture was the wrong trade.
 */
export function probeImageSize(uri: string): Promise<ChatImageNaturalSize | null> {
  return new Promise((resolve) => {
    // Guarded rather than assumed. A host without `getSize` should hand back
    // the reserved square, not throw inside a decrypt effect and take the row
    // down with it.
    if (typeof Image.getSize !== 'function') {
      resolve(null);
      return;
    }
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve(null),
    );
  });
}

export interface ChatImageProps {
  uri: string | null;
  accessibilityLabel: string;
  /** Available width. Defaults to the shared slot. */
  slotWidth?: number;
  /** Shown only when the rule actually cropped. Caller owns i18n. */
  croppedLabel: string;
  /**
   * What the SENDER measured, when the attachment envelope carries it.
   *
   * `Image.getSize` is still the authority — this only decides what the row
   * looks like during the wait. Without it the rule has nothing to work from
   * and falls back to a square, so a screenshot's row grew 80px and a panorama's
   * shrank 144px the instant the file finished decoding: the same jump the
   * envelope was added to remove, one step later than the reserved placeholder
   * that already fixed the first half.
   */
  hintWidth?: number;
  hintHeight?: number;
  testID?: string;
}

export function ChatImage({
  uri,
  accessibilityLabel,
  slotWidth = CHAT_IMAGE_SLOT_WIDTH,
  croppedLabel,
  hintWidth,
  hintHeight,
  testID,
}: ChatImageProps) {
  const [size, setSize] = useState<ChatImageNaturalSize | null>(null);

  useEffect(() => {
    setSize(null);
    if (!uri) return;
    let cancelled = false;
    void probeImageSize(uri).then((measured) => {
      if (!cancelled) setSize(measured);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  /*
   * The probe wins once it lands; the hint only stands in until then. A sender
   * that measured wrong is corrected by the file itself, so a bad hint costs
   * one reflow rather than a permanently wrong box.
   */
  const shownWidth = size?.width ?? hintWidth;
  const shownHeight = size?.height ?? hintHeight;
  const box: ChatMediaBox = chatMediaBox(shownWidth, shownHeight, slotWidth);

  /*
   * The crop is performed by the CLIPPING VIEW, not by `resizeMode`.
   *
   * `resizeMode="cover"` crops from the centre and offers no way to say
   * otherwise, and a centre-cropped screenshot loses the heading that says what
   * it is. So the inner <Image> is laid out at its FULL height for this width
   * and the wrapper clips the overflow, which puts the surviving pixels at
   * whichever edge the rule asked for.
   */
  const measurable = Boolean(shownWidth && shownHeight && shownWidth > 0 && shownHeight > 0);
  /*
   * The cover scale: whichever axis needs the most enlargement to reach the
   * box, so the picture covers it on both. Getting this from the WIDTH alone
   * was wrong for a wide picture, which overflows sideways and falls SHORT
   * vertically — it left a panorama letterboxed inside its own crop.
   */
  const scale = measurable
    ? Math.max(box.width / shownWidth!, box.height / shownHeight!)
    : 1;
  const drawWidth = measurable ? Math.round(shownWidth! * scale) : box.width;
  const drawHeight = measurable ? Math.round(shownHeight! * scale) : box.height;
  /*
   * `|| 0` normalises the negative zero that `-Math.round(0)` produces. It
   * lays out identically, but it reads as a real offset in a snapshot and in
   * every assertion written against it.
   */
  const offsetX = -Math.round((drawWidth - box.width) / 2) || 0;
  const offsetY = (box.anchor === 'top' ? 0 : -Math.round((drawHeight - box.height) / 2)) || 0;

  return (
    /*
     * The frame is NOT itself `accessible`. It sits inside the bubble's
     * TouchableOpacity, and a nested accessible element there splits one
     * "open this picture" target into two, one of which does nothing. The
     * label stays on the picture, where it was before this component existed.
     */
    <View testID={testID} style={[styles.frame, { width: box.width, height: box.height }]}>
      {uri ? (
        <Image
          source={{ uri }}
          accessibilityLabel={accessibilityLabel}
          testID={testID ? `${testID}-img` : undefined}
          style={{
            width: drawWidth,
            height: drawHeight,
            marginTop: offsetY,
            marginLeft: offsetX,
          }}
          // `cover` and not `contain`: at this point the box and the picture
          // already share a ratio, so cover is a no-op that also guards against
          // a rounding pixel. Contain would letterbox, which is the sliver with
          // bars around it.
          resizeMode="cover"
        />
      ) : null}
      {box.cropped ? (
        // A crop nobody is told about is indistinguishable from a picture that
        // ends there. The pill says both "there is more" and what to do.
        <View style={styles.badge} pointerEvents="none" testID="chat-image-cropped-badge">
          <Text style={styles.badgeText}>{croppedLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: RADIUS.card,
    overflow: 'hidden',
    backgroundColor: 'rgba(127,127,127,0.08)',
  },
  badge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  badgeText: {
    color: '#fff',
    fontSize: TYPE_SCALE.label,
    lineHeight: 16,
  },
});
