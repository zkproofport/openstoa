import React from 'react';
import {
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { RADIUS, TYPE_SCALE } from '../theme/tokens';
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
  /** Label for the save control; supplied by the caller, which owns i18n. */
  saveLabel?: string;
}

// Lightweight full-screen image viewer for chat images. We deliberately
// do NOT route through the in-app WebView — opening
// `media.zkproofport.app/.../img.png` in a browser renders the raw
// image at the top with a blank page below it, which is exactly the
// "white space" the user complained about.
//
// Tap-to-dismiss + a × button. Image is letterboxed inside the viewport
// so wide and tall images both fit.
export default function ImageViewerModal({ url, onClose, onSave, saveLabel }: Props) {
  const { width, height } = useWindowDimensions();
  if (!url) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close">
            <Text style={styles.closeLabel}>×</Text>
          </TouchableOpacity>
          {/*
            Saving lives HERE rather than on the bubble, because this is where
            somebody has already said "show me this properly" — and because the
            bubble has no room for a second control that would not also be in
            the way of the first.
          */}
          {onSave ? (
            <TouchableOpacity
              style={styles.saveBtn}
              onPress={onSave}
              accessibilityRole="button"
              accessibilityLabel={saveLabel}
              testID="image-viewer-save"
            >
              <Text style={styles.saveLabel}>{saveLabel}</Text>
            </TouchableOpacity>
          ) : null}
          <View pointerEvents="none">
            <GatedImage
              uri={url}
              style={{ width, height: height - 80 }}
              resizeMode="contain"
            />
          </View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bottom, not beside the ×: the two do opposite things, and a save button
  // within a thumb's slip of "close" is one somebody will hit by accident.
  saveBtn: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    paddingHorizontal: 20,
    height: 44,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  saveLabel: {
    color: '#fff',
    fontSize: TYPE_SCALE.label,
    fontWeight: '600',
  },
  closeBtn: {
    position: 'absolute',
    top: 48,
    right: 16,
    width: 38,
    height: 38,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  closeLabel: {
    color: '#fff',
    fontSize: TYPE_SCALE.headingSmall,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: -2,
  },
});
