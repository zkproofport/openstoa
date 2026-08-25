import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';

export interface WaitingStatusProps {
  /** What is being waited for. Keep it short — this is a status, not prose. */
  label: string;
  color: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

const DOTS = 3;
/** One pass across all the dots, in ms. */
const CYCLE_MS = 1500;

/**
 * Pull ONLY the type metrics out of a caller's label style.
 *
 * A dot has to sit on the label's baseline, so it needs the same size and line
 * height — and nothing else. Taking the whole style is what let a caller's
 * `flex: 1` reach the dots; naming the two properties makes that impossible
 * rather than merely unlikely.
 */
function typography(style: StyleProp<TextStyle>): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  const out: TextStyle = {};
  if (flat.fontSize !== undefined) out.fontSize = flat.fontSize;
  if (flat.lineHeight !== undefined) out.lineHeight = flat.lineHeight;
  return out;
}

/**
 * The finished style for one dot, given the caller's label style.
 *
 * Exported for `chatRoomKeyWaitLayout.test.tsx`. The defect it guards against
 * was pure style — a `flex: 1` reaching the dots — so the assertion belongs on
 * the computed style, not on a render.
 */
export function __waitingDotStyle(style: StyleProp<TextStyle>): TextStyle {
  return { ...styles.dot, ...typography(style) };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline' },
  dots: { flexDirection: 'row' },
  /* A dot never grows: it is one glyph beside a label, not a column. */
  dot: { flexGrow: 0, flexShrink: 0 },
});

/**
 * A status line that keeps moving for a wait with no known end.
 *
 * This exists because a spinner was the wrong promise. A spinner means "a
 * moment", and the wait it replaced — for another device to share a chat key —
 * is not one: it ends when somebody else's phone comes online, which might be
 * seconds or might be tomorrow morning. Run that long a spinner reads as a
 * hang, and stopped early it read as failure, because the messages underneath
 * it were still locked.
 *
 * Trailing dots make no claim about duration. They say the app is still on it,
 * for exactly as long as that is true, and they say it as part of the sentence
 * rather than as a second thing to watch.
 *
 * Opacity only, on the native driver: this may sit on screen indefinitely, so
 * it must cost nothing on the JS thread while it does.
 */
export function WaitingStatus({ label, color, style, testID }: WaitingStatusProps) {
  // A ref per dot: these are handed to the animation driver and must survive
  // re-renders without restarting mid-cycle.
  const dots = useRef(Array.from({ length: DOTS }, () => new Animated.Value(0.2))).current;

  useEffect(() => {
    const step = Math.round(CYCLE_MS / DOTS);
    const loops = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          // Staggered start is what makes it travel rather than blink in
          // unison — the difference between "working" and "error light".
          Animated.delay(i * step),
          Animated.timing(dot, {
            toValue: 1,
            duration: step,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.2,
            duration: step,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          // Hold while the others finish their pass, so every dot has the same
          // cycle length and the pattern never drifts apart.
          Animated.delay((DOTS - 1 - i) * step),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => {
      loops.forEach((l) => l.stop());
      // Stopped mid-fade, a dot would keep whatever opacity it landed on.
      dots.forEach((d) => d.setValue(0.2));
    };
  }, [dots]);

  return (
    <View style={styles.row} testID={testID}>
      <Animated.Text style={[style, { color }]}>{label}</Animated.Text>
      {/* Hidden from assistive tech: the label already says everything, and
          three animated full stops read aloud are noise. */}
      <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no">
        {dots.map((dot, i) => (
          /*
           * `styles.dot`, NOT the caller's `style`.
           *
           * The dots used to reuse the label's style wholesale, which was fine
           * until a caller passed one containing layout. `ChatRoomScreen`'s
           * `keyWaitText` carries `flex: 1` — meant to make the LABEL fill the
           * row so the dots sit at its end — and handing that to each dot gave
           * every dot `flexGrow: 1` and `flexBasis: 0` as well. Measured on the
           * device: the three dots took a third of the screen width each
           * (x=39-374, 372-706, 706-1041), the label collapsed to zero width
           * and stretched to 1,734px tall, and the composer was pushed off the
           * screen. The room looked completely broken.
           *
           * Only the two things a dot actually shares with its label are taken:
           * the type metrics, so it sits on the same line, and the colour.
           */
          <Animated.Text
            key={i}
            style={[__waitingDotStyle(style), { color, opacity: dot }]}
          >
            ·
          </Animated.Text>
        ))}
      </View>
    </View>
  );
}
