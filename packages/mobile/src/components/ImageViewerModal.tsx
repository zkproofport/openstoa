import React from 'react';
import {
  Image,
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';

interface Props {
  url: string | null;
  onClose: () => void;
}

// Lightweight full-screen image viewer for chat images. We deliberately
// do NOT route through the in-app WebView — opening
// `media.zkproofport.app/.../img.png` in a browser renders the raw
// image at the top with a blank page below it, which is exactly the
// "white space" the user complained about.
//
// Tap-to-dismiss + a × button. Image is letterboxed inside the viewport
// so wide and tall images both fit.
export default function ImageViewerModal({ url, onClose }: Props) {
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
          <View pointerEvents="none">
            <Image
              source={{ uri: url }}
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
  closeBtn: {
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
  closeLabel: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: -2,
  },
});
