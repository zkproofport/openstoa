/**
 * The room's name is centred on the HEADER, not on whatever gap the controls
 * leave behind — and a long one never slides under them.
 *
 * WHAT WENT WRONG. The name was a flexible box between the back arrow and the
 * controls, centred inside that leftover space. With nothing on the right that
 * is the same thing as centred. A chat room has four controls there — the lock,
 * the member list, the mute and the presence dot — so its name sat visibly left
 * of centre, which is what was reported: "오른쪽 이미지들에 밀리는 것 같은데".
 *
 * The long-name question was asked at the same time and the answer was already
 * yes: one line, ellipsised. That behaviour is pinned here so the fix for the
 * centring cannot quietly take it away — the name now sits in a layer spanning
 * the whole header, and a layer with no width limit would happily run straight
 * under the icons.
 *
 * EDGE-CASE MATRIX → coverage
 *   contract   → the name's layer spans the whole header, not the gap
 *   contract   → taps still reach the controls underneath it
 *   integrity  → the same width is kept clear on both sides
 *   boundary   → no controls at all falls back to the arrow's width
 *   large      → a very long name stays on one line and ellipsises
 *   UTF-8      → Korean, emoji and mixed scripts are drawn unchanged
 *   empty      → a screen with no name draws an empty title, not a crash
 *   hostile    → newlines and tabs in a name cannot make the header grow
 *   authz/race/external → N/A: this draws props, makes no request and owns no
 *                         lifecycle
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { Text, View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { render, flush } from './harness/render';
import { useMiniAppStackScreenOptions } from '../navigation/shared';

type Style = Record<string, number | string | undefined>;
const flatten = (style: unknown): Style =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style ?? {}) as Style);

/** Mount the header the navigator would draw for these options. */
async function header(opts: {
  title?: string;
  right?: React.ReactNode;
  rightWidth?: number;
}) {
  function Harness() {
    const screenOptions = useMiniAppStackScreenOptions();
    const Header = screenOptions.header!;
    return Header({
      navigation: { goBack: vi.fn() },
      route: { key: 'k', name: 'ChatRoom' },
      options: {
        title: opts.title,
        headerRight: opts.right ? () => opts.right : undefined,
      },
      back: { title: 'Back' },
    } as never) as React.ReactElement;
  }
  const r = await render(<Harness />);
  if (opts.rightWidth !== undefined) {
    // Report the measurement the platform would report for the controls.
    const measured = r.root
      .findAll((n) => typeof n.type === 'string')
      .find((n) => typeof n.props.onLayout === 'function');
    await act(async () => {
      measured?.props.onLayout({ nativeEvent: { layout: { width: opts.rightWidth } } });
    });
  }
  await flush();
  return r;
}

/** The layer the name is drawn in — the one that fills the whole header. */
function titleLayer(root: ReactTestInstance): ReactTestInstance | undefined {
  return root
    .findAll((n) => typeof n.type === 'string')
    .find((n) => {
      const s = flatten(n.props.style);
      return s.position === 'absolute' && s.justifyContent === 'center' && s.alignItems === 'center';
    });
}

function titleText(root: ReactTestInstance): ReactTestInstance | undefined {
  const layer = titleLayer(root);
  return layer?.findAll((n) => typeof n.type === 'string' && n.props.numberOfLines === 1)[0];
}

const FOUR_CONTROLS = (
  <View>
    <Text>lock</Text>
    <Text>members</Text>
    <Text>mute</Text>
    <Text>presence</Text>
  </View>
);

describe('the room name sits in the middle of the header', () => {
  it('THE DEFECT: the name spans the whole header, not the gap beside the controls', async () => {
    const r = await header({ title: 'My space', right: FOUR_CONTROLS, rightWidth: 110 });
    const layer = titleLayer(r.root);
    expect(layer).toBeDefined();
    const s = flatten(layer!.props.style);
    // Absolutely filling the row is what makes "centred" mean the header.
    expect(s.position).toBe('absolute');
    expect(s.left).toBe(0);
    expect(s.right).toBe(0);
  });

  it('CONTRACT: taps pass through the name to the controls beneath it', async () => {
    const r = await header({ title: 'My space', right: FOUR_CONTROLS, rightWidth: 110 });
    // A layer across the whole header that swallowed touches would make the
    // back arrow and every control unpressable.
    expect(titleLayer(r.root)!.props.pointerEvents).toBe('none');
  });

  it('INTEGRITY: the same width is kept clear on both sides, so it stays centred', async () => {
    const r = await header({ title: 'My space', right: FOUR_CONTROLS, rightWidth: 110 });
    const s = flatten(titleText(r.root)!.props.style);
    // One symmetric value — a different left and right is off-centre again.
    expect(s.marginHorizontal).toBeGreaterThanOrEqual(110);
    expect(s.marginLeft).toBeUndefined();
    expect(s.marginRight).toBeUndefined();
  });

  it('BOUNDARY: with no controls, the arrow’s own width is kept clear', async () => {
    const r = await header({ title: 'Feed' });
    const s = flatten(titleText(r.root)!.props.style);
    expect(s.marginHorizontal).toBeGreaterThanOrEqual(32);
  });

  it('VERY LARGE: a long name stays on one line and ellipsises', async () => {
    const long = 'a-very-long-topic-name-'.repeat(20);
    const r = await header({ title: long, right: FOUR_CONTROLS, rightWidth: 110 });
    const text = titleText(r.root)!;
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
  });

  it('UTF-8: Korean, emoji and mixed scripts are drawn as given', async () => {
    for (const name of ['한글 토픽방', '🎉 파티 🎊', 'ZK 증명 proofs 混合', '   ']) {
      const r = await header({ title: name, right: FOUR_CONTROLS, rightWidth: 110 });
      expect(titleText(r.root)!.props.children).toBe(name);
    }
  });

  it('EMPTY: a screen with no name draws an empty title rather than crashing', async () => {
    const r = await header({});
    expect(titleText(r.root)!.props.children).toBe('');
  });

  it('HOSTILE: newlines and tabs cannot make the header grow', async () => {
    const r = await header({ title: 'line one\nline two\tand more\n\n\n' });
    // One line is the whole defence: without it a pasted name would push the
    // controls off their own row.
    expect(titleText(r.root)!.props.numberOfLines).toBe(1);
  });
});
