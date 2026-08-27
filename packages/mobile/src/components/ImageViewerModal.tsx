import React from 'react';
import {
  Modal,
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

interface Props {
  url: string | null;
  onClose: () => void;
  /**
   * Offer a way to keep this picture. Optional because not every image the
   * viewer shows is one this device holds the bytes for — a plaintext image
   * from before attachments were encrypted is a remote URL, and "save" for
   * that would mean a download this component has no business starting.
   */
  onSave?: () => void;
  /**
   * The save control's accessible name. NOT drawn.
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
 * ICONS, NOT WORDS. "Save" is a word that needs translating, gets clipped, and
 * grows the control; a download glyph is understood without either. The strings
 * stay as accessible names.
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
  if (!url) return null;

  const barHeight = 56;
  const topInset = insets.top;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        {/*
          Tap-to-dismiss covers the PICTURE only, not the bar. Wrapping the whole
          screen (as this used to) makes every tap that misses an icon dismiss
          the viewer, so the bar's own padding becomes a trap.
        */}
        <TouchableWithoutFeedback onPress={onClose} accessible={false}>
          <View style={styles.imageArea} pointerEvents="box-only">
            <View pointerEvents="none">
              <GatedImage
                uri={url}
                style={{ width, height: height - barHeight - topInset - insets.bottom }}
                resizeMode="contain"
              />
            </View>
          </View>
        </TouchableWithoutFeedback>

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
              <Feather name="download" size={22} color="#fff" />
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
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  imageArea: {
    flex: 1,
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
