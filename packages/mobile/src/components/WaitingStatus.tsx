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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline' },
  dots: { flexDirection: 'row' },
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
          <Animated.Text key={i} style={[style, { color, opacity: dot }]}>
            ·
          </Animated.Text>
        ))}
      </View>
    </View>
  );
}
