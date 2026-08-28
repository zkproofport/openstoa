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
import Feather from 'react-native-vector-icons/Feather';
import {
  ActivityIndicator,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

/*
 * Icons, not words.
 *
 * These controls sit to the left of a bubble that may claim three quarters of
 * the width, so "Resend" and "Delete" spelled out pushed themselves off the
 * left edge of the screen — Retry became literally unreachable on a message
 * carrying a long link. Two glyphs cost a fifth of the space and read the same
 * in every language the app ships. The words survive as the accessibility
 * label, which is the half a screen reader needed anyway.
 */
const ICON_SIZE = 18;

export interface MessageFailedControlsProps {
  /**
   * The attachment's bytes are gone — the collector took them before the app
   * came back. Retry is replaced by an explanation, because re-sending would
   * post a message pointing at nothing and every reader would see a
   * permanently broken picture.
   */
  expired?: boolean;
  /**
   * The retry is in flight — a spinner replaces BOTH controls.
   *
   * Without it, pressing Retry looked like nothing happened. A send that fails
   * before it reaches the network fails in milliseconds, so the row flickered
   * and came back reading exactly as before; the only honest reading was that
   * the button was dead.
   *
   * Discard goes too. It was left live at first, on the reasoning that an
   * attempt can sit on the deadline for half a minute — but a Delete beside a
   * spinner invites discarding a message that is still on its way, and the
   * attempt is bounded by that deadline anyway.
   */
  retrying?: boolean;
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
  retrying,
  onRetry,
  onDiscard,
  t,
  styles,
}: MessageFailedControlsProps) {
  return (
    <View style={styles.sendFailed}>
      <Text style={styles.sendFailedMark}>!</Text>
      {/* Only the spinner stands alone. Discard is the way out of both other
          states, and an expired attachment has nothing BUT a way out. */}
      {retrying ? (
        <ActivityIndicator
          size="small"
          accessibilityLabel={t('openstoa.chat.sendFailedRetrying')}
        />
      ) : (
        <>
          {expired ? (
            <Text style={styles.lockedBody}>{t('openstoa.chat.media.expired')}</Text>
          ) : (
            <TouchableOpacity
              onPress={onRetry}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('openstoa.chat.sendFailedRetry')}
            >
              <Feather name="refresh-cw" size={ICON_SIZE} style={styles.sendFailedAction} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={onDiscard}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('openstoa.chat.sendFailedDiscard')}
          >
            <Feather name="x" size={ICON_SIZE} style={styles.sendFailedDiscard} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

export default MessageFailedControls;
