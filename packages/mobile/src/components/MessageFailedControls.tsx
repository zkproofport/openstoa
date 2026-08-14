/**
 * What a message that did not send offers the sender: Retry, or Discard.
 *
 * Extracted from `ChatRoomScreen` so it can be RENDERED in a test. It is the
 * whole user-facing contract of the failed-send path — including the one state
 * that has no retry — and it lived inside a 2 000-line screen that no test
 * could mount, which is how the web ended up with nine tests for this and the
 * phone with none.
 *
 * Deliberately dumb: it takes what to show and what to call, and owns no
 * lifecycle. Whether an attachment's bytes are still there is decided by the
 * screen (which probes the object); this only draws the answer.
 */
import React from 'react';
import { Text, TouchableOpacity, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export interface MessageFailedControlsProps {
  /**
   * The attachment's bytes are gone — the collector took them before the app
   * came back. Retry is replaced by an explanation, because re-sending would
   * post a message pointing at nothing and every reader would see a
   * permanently broken picture.
   */
  expired?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  /** `t` from the screen — passed in so this component holds no i18n wiring. */
  t: (key: string) => string;
  /** The slice of the screen's stylesheet these controls use. */
  styles: {
    sendFailed?: StyleProp<ViewStyle>;
    sendFailedMark?: StyleProp<TextStyle>;
    sendFailedAction?: StyleProp<TextStyle>;
    sendFailedDiscard?: StyleProp<TextStyle>;
    lockedBody?: StyleProp<TextStyle>;
  };
}

export function MessageFailedControls({
  expired,
  onRetry,
  onDiscard,
  t,
  styles,
}: MessageFailedControlsProps) {
  return (
    <View style={styles.sendFailed}>
      <Text style={styles.sendFailedMark}>!</Text>
      {expired ? (
        <Text style={styles.lockedBody}>{t('openstoa.chat.media.expired')}</Text>
      ) : (
        <TouchableOpacity onPress={onRetry} activeOpacity={0.7}>
          <Text style={styles.sendFailedAction}>{t('openstoa.chat.sendFailedRetry')}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onDiscard} activeOpacity={0.7}>
        <Text style={styles.sendFailedDiscard}>{t('openstoa.chat.sendFailedDiscard')}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default MessageFailedControls;
