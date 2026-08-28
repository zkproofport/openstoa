import React, { useEffect, useState } from 'react';
import {
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import Feather from 'react-native-vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS } from '../theme/tokens';
import { GatedImage } from './GatedImage';
import { probeImageSize } from './ChatImage';

interface Props {
  url: string | null;
  onClose: () => void;
  /**
   * Offer a way to keep this picture. Optional because not every image the
   * viewer shows is one this device holds the bytes for — a plaintext image
   * from before attachments were encrypted is a remote URL, and offering it for
   * that would mean a download this component has no business starting.
   */
  onSave?: () => void;
  /**
   * The control's accessible name. NOT drawn.
   *
   * The control is an icon, so this is what a screen reader announces and the
   * only reason the caller still owns the string — an unlabelled icon button is
   * a button that says nothing to somebody who cannot see it.
   */
  saveLabel?: string;
  /** Same, for close. */
  closeLabel?: string;
}

/*
 * Full-screen image viewer for chat images.
 *
 * THE CONTROLS LIVE IN A BAR, not on the picture. They used to float — a "Save"
 * pill centred at `bottom: 48` and a `×` at `top: 48` — both directly over the
 * image, which is letterboxed to fill the screen. On a photo with light content
 * behind them the text and the button both disappeared, which is exactly what
 * was reported: "글씨도 버튼도 제대로 안 보여". A translucent bar with its own
 * ground fixes it for every image rather than for the ones that happen to be
 * dark, and it is where every photo viewer people already use puts them.
 *
 * ICONS, NOT WORDS. A word needs translating, gets clipped, and grows the
 * control; a glyph is understood without any of that. The strings stay as
 * accessible names.
 *
 * A SHARE GLYPH, NOT A DOWNLOAD ARROW. The arrow promises that pressing it puts
 * the picture in the photo library, and that is not what happens: it opens the
 * system share sheet, where saving to Photos is one choice among sending it to
 * another app or cancelling. `saveAttachment` even reports those three outcomes
 * separately. An icon that promises what the code does not do is the defect —
 * reported as "누르면 바로 안 받고 공유하기가 뜬다".
 *
 * CLOSE LEFT, SAVE RIGHT — opposite ends, because they do opposite things and a
 * destructive-adjacent mis-tap ("I meant to keep it, I dismissed it") is the one
 * failure this layout can design out. The old layout had the same instinct
 * (`saveBtn` bottom, `×` top) but paid for it by putting one of them in the
 * middle of the picture.
 *
 * DELIBERATELY NOT the in-app WebView: opening `media.zkproofport.app/.../img.png`
 * in a browser renders the raw image at the top with a blank page below it,
 * which is the "white space" that produced this component in the first place.
 */
export default function ImageViewerModal({
  url,
  onClose,
  onSave,
  saveLabel,
  closeLabel,
}: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  /*
   * A TALL PICTURE IS SHOWN AT FULL WIDTH AND SCROLLED, not shrunk to fit.
   *
   * Fitting the whole image on one screen is right for a photo and useless for
   * a screenshot: a phone-page capture is roughly 1:9 here, so fitting it made
   * a sliver about a tenth of the screen wide with nothing readable in it. The
   * same picture in KakaoTalk opens at full width and scrolls down, which is
   * what anyone opening a screenshot is trying to do — read it.
   *
   * The measurement is the picture's own. Until it lands, the old fit-to-screen
   * behaviour holds, so nothing flickers and an unreadable size just keeps it.
   */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setNatural(null);
    if (!url) return;
    let alive = true;
    void probeImageSize(url).then((size) => {
      if (!alive || !size || size.width <= 0 || size.height <= 0) return;
      setNatural(size);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!url) return null;

  const barHeight = 56;
  const topInset = insets.top;
  const visibleHeight = height - barHeight - topInset - insets.bottom;

  // At full width, how tall would it be? Taller than the screen means scroll.
  const fullWidthHeight = natural ? (width * natural.height) / natural.width : 0;
  const scrolls = fullWidthHeight > visibleHeight;
  const imageStyle = scrolls
    ? { width, height: fullWidthHeight }
    : { width, height: visibleHeight };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        {/*
          Tap-to-dismiss covers the PICTURE only, not the bar. Wrapping the whole
          screen (as this used to) makes every tap that misses an icon dismiss
          the viewer, so the bar's own padding becomes a trap.
        */}
        <ScrollView
          style={styles.imageArea}
          // Centres a short picture; lets a tall one start at the top, where
          // reading it starts.
          contentContainerStyle={scrolls ? undefined : styles.centred}
          /*
           * The inset is for the SCROLLING case only.
           *
           * The bar sits over the top of a picture that scrolls, so without it
           * the first screenful hides behind the bar. A picture that already
           * fits needs none — and applying it anyway pushed the whole thing a
           * hundred points down the screen, which is exactly what it looked
           * like: centred, but centred inside a box that started below the top.
           */
          contentInset={scrolls ? { top: barHeight + topInset } : undefined}
          contentOffset={scrolls ? { x: 0, y: -(barHeight + topInset) } : undefined}
          scrollEnabled={scrolls}
          showsVerticalScrollIndicator={scrolls}
        >
          {/*
            Tap-to-dismiss covers the PICTURE only, not the bar. Wrapping the
            whole screen (as this used to) makes every tap that misses an icon
            dismiss the viewer, so the bar's own padding becomes a trap.
          */}
          <TouchableWithoutFeedback onPress={onClose} accessible={false}>
            <View pointerEvents="box-only">
              <View pointerEvents="none">
                <GatedImage
                  uri={url}
                  style={imageStyle}
                  // `contain` while it still fits the screen, `cover` once it is
                  // being scrolled — at full width with the true height there is
                  // nothing to crop, and `contain` would letterbox it instead.
                  resizeMode={scrolls ? 'cover' : 'contain'}
                />
              </View>
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>

        <View style={[styles.bar, { top: 0, paddingTop: topInset, height: barHeight + topInset }]}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel ?? 'Close'}
            testID="image-viewer-close"
            // A 44pt target on a 24pt glyph: the visual weight stays light while
            // the thing a thumb has to hit does not.
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x" size={24} color="#fff" />
          </TouchableOpacity>

          {onSave ? (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={onSave}
              accessibilityRole="button"
              accessibilityLabel={saveLabel}
              testID="image-viewer-save"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="share" size={22} color="#fff" />
            </TouchableOpacity>
          ) : (
            // Holds the row's shape so `x` does not drift to the centre when
            // there is nothing to save.
            <View style={styles.iconBtn} />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    /*
     * OPAQUE. The five percent of translucency left the chat visible behind
     * the picture — message bubbles and the composer showing through the empty
     * space around a photo, which reads as a rendering fault rather than a
     * viewer. Every photo viewer people already use is solid, and nothing here
     * needs to be seen through: the way back is the close control, not a
     * glimpse of what is underneath.
     */
    backgroundColor: '#000',
  },
  imageArea: {
    flex: 1,
  },
  centred: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
   * Its own ground, slightly lighter than the backdrop rather than transparent.
   * A bar that borrows the image's colours is a bar that vanishes on a bright
   * photo — the defect this replaces.
   */
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 1,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
