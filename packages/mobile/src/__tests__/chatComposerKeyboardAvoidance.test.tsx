/**
 * The chat composer asks for the keyboard offset to be MEASURED, not guessed.
 *
 * READ THIS BEFORE TRUSTING THE FILE: none of these tests can tell you that
 * the composer clears the keyboard on a phone. There is no window here, no
 * keyboard, and no layout — `render.tsx` builds a tree, not a screen. Keyboard
 * geometry is device-verified, and nothing in this package changes that.
 *
 * What it CAN pin is the mechanism, and the mechanism is where this went wrong
 * twice. An avoiding view of this shape compares its own frame against the
 * keyboard's, and those frames are reported in two different coordinate
 * spaces: `onLayout` gives a position relative to the PARENT, the keyboard
 * gives one in the window. `keyboardVerticalOffset` is the hand-written bridge
 * between them — "distance between the top of the user screen and the React
 * Native view" — so its correct value depends on the entire ancestor chain
 * this screen happens to be mounted in (mini-app JS header → mini-app tab
 * navigator → host tab navigator). It has now been wrong in both directions:
 * 88 left a visible gap above the keyboard (fixed 2026-05-18), then 0 hid the
 * composer behind it entirely (reported with screenshots 2026-08-24).
 *
 * `automaticOffset` deletes the question by asking the native side where the
 * view actually is. So the regression worth catching from a unit test is
 * someone reaching for a magic number again — and that is exactly what these
 * assertions fail on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderScreen } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatRoomScreen } from '../screens/chat/ChatRoomScreen';

const TOPIC = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/chat/media')
        ? { ciphertext: '' }
        : { messages: [], total: 0, topic: { visibility: 'public' }, members: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }),
  );
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId: 'nullifier-me',
    nickname: 'me',
    needsNickname: false,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    role: 'member',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useOpenStoaSession.setState({
    mode: 'unknown',
    token: null,
    userId: null,
    nickname: null,
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function avoidingViews(root: any): any[] {
  return root.findAll((n: any) => typeof n.type === 'string' && n.type === 'KeyboardAvoidingView');
}

describe('ChatRoomScreen — keyboard avoidance is measured, not guessed', () => {
  it('CONTRACT: the screen roots in ONE avoiding view that asks for automaticOffset', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    const views = avoidingViews(rendered.root);
    // Exactly one: two nested avoiding views each apply their own padding and
    // the composer travels twice as far as the keyboard.
    expect(views, 'expected exactly one KeyboardAvoidingView in the chat room').toHaveLength(1);
    expect(views[0].props.automaticOffset).toBe(true);

    rendered.unmount();
  });

  it('REGRESSION: no hand-tuned keyboardVerticalOffset', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    const { keyboardVerticalOffset } = avoidingViews(rendered.root)[0].props;
    // 0 or absent, both fine — what must never come back is a constant
    // standing in for a header height that this file cannot see and that
    // changes with the device, the nesting and the safe-area inset.
    expect(
      keyboardVerticalOffset ?? 0,
      'a non-zero keyboardVerticalOffset is a guess about the ancestor chain — use automaticOffset',
    ).toBe(0);

    rendered.unmount();
  });

  it('CONTRACT: padding behaviour on iOS — the list gives up the space, so the last message stays visible', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    // The stand-in reports `Platform.OS === 'ios'`, which is the platform this
    // was reported on. `padding` shrinks the content box, so the message list
    // above the composer shrinks with it; `position` and `translate-*` would
    // slide the whole screen up and take the newest messages off the top.
    expect(avoidingViews(rendered.root)[0].props.behavior).toBe('padding');

    rendered.unmount();
  });

  it('the composer is the LAST child, so padding moves it', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    // Padding at the bottom of the avoiding view only lifts what sits at the
    // bottom of the avoiding view. If the composer were moved into a sibling
    // of the avoiding view (a plausible refactor — it is visually a separate
    // bar) the padding would still be applied and would still lift nothing.
    const composer = rendered.root.findAll(
      (n: any) => typeof n.type === 'string' && n.type === 'TextInput'
        && n.props.placeholder === 'openstoa.chat.messagePlaceholder',
    )[0];
    expect(composer, 'composer TextInput not found').toBeDefined();

    const view = avoidingViews(rendered.root)[0];
    expect(
      view.findAll((n: any) => n === composer).length,
      'the composer is outside the KeyboardAvoidingView — padding cannot move it',
    ).toBe(1);

    rendered.unmount();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
