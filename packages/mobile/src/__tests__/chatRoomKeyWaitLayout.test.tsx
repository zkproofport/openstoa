/**
 * A waiting caption is a caption, and its dots are punctuation.
 *
 * THE DEFECT, measured on a real device (SM-A235N, 1080x2408). `WaitingStatus`
 * handed the caller's LABEL style to each of its three animated dots as well.
 * `ChatRoomScreen` passes `keyWaitText`, which carries `flex: 1` so the label
 * fills the row and the dots trail at its end — and giving that to a dot gave
 * it `flexGrow: 1` and `flexBasis: 0` too. The result, from the device's own
 * view bounds:
 *
 *     TextView  ·   x=  39- 374     each dot took a THIRD of the screen width
 *     TextView  ·   x= 372- 706
 *     TextView  ·   x= 706-1041
 *     ViewGroup     y= 218-1952     the label, zero-width and 1,734px tall
 *     TextView      y=1957-2104     the hint, pushed to the bottom edge
 *
 * The message list was squeezed to nothing and the composer was pushed off the
 * screen entirely. The room read as completely broken, and none of it was
 * visible in a `uiautomator` text dump — the same strings appear whether the
 * caption is two lines or the whole display. Only the bounds showed it.
 *
 * MY FIRST FIX WAS WRONG and is worth recording: I put `flexGrow: 0` on the
 * notice CONTAINER, rebuilt, installed, and the bounds came back at 1,734px
 * unchanged. The container was never the thing growing. Reading the parent /
 * child relationships rather than the flat list is what found the dots.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a dot takes the label's type metrics, so it sits on the line
 *   integrity  → a dot takes NO layout from the label, whatever the label has
 *   hostile    → a caller style carrying width, flex, margin or position leaks
 *                none of it
 *   empty      → no style at all, and an explicitly empty one
 *   boundary   → the notice itself is still pinned to its content height
 */
import { describe, it, expect } from 'vitest';
import { StyleSheet } from 'react-native';
import { makeStyles } from '../screens/chat/ChatRoomScreen';
import { darkColors } from '../theme/colors';
import { __waitingDotStyle } from '../components/WaitingStatus';

describe('the waiting dots take type, never layout', () => {
  it('CONTRACT: a dot inherits the size and line height, so it sits on the baseline', () => {
    const dot = StyleSheet.flatten(__waitingDotStyle({ fontSize: 13, lineHeight: 18 }));
    expect(dot.fontSize).toBe(13);
    expect(dot.lineHeight).toBe(18);
  });

  it('INTEGRITY: a dot inherits NO flex, whatever the label was given', () => {
    // This exact style is what `ChatRoomScreen` passes.
    const dot = StyleSheet.flatten(
      __waitingDotStyle({ flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' }),
    );
    expect(dot.flex).toBeUndefined();
    expect(dot.flexGrow).toBe(0);
    expect(dot.flexShrink).toBe(0);
  });

  it.each([
    ['width', { width: 300 }],
    ['flexBasis', { flexBasis: 0 }],
    ['margin', { margin: 24 }],
    ['padding', { padding: 24 }],
    ['position', { position: 'absolute' as const }],
    ['alignSelf', { alignSelf: 'stretch' as const }],
    ['height', { height: 400 }],
  ])('HOSTILE: a label style carrying %s leaks none of it to a dot', (key, extra) => {
    const dot = StyleSheet.flatten(__waitingDotStyle({ fontSize: 13, ...extra }));
    expect(dot[key as keyof typeof dot]).toBeUndefined();
  });

  it.each([
    ['no style at all', undefined],
    ['an empty style', {}],
  ])('EMPTY: %s still produces a dot that cannot grow', (_label, style) => {
    const dot = StyleSheet.flatten(__waitingDotStyle(style));
    expect(dot.flexGrow).toBe(0);
  });

  it('BOUNDARY: the notice around them is still pinned to its content height', () => {
    const styles = makeStyles(darkColors);
    // Both halves: `flexGrow: 0` so it cannot absorb spare space, `flexShrink: 0`
    // so a long conversation cannot crush the caption to nothing.
    expect(styles.keyWaitNotice.flexGrow).toBe(0);
    expect(styles.keyWaitNotice.flexShrink).toBe(0);
  });
});
