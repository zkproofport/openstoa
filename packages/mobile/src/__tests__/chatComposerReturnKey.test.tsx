/**
 * Return on the mini-app composer inserts a NEWLINE. It does not send.
 *
 * This file previously pinned the opposite. An earlier lane read the report
 * "채팅에 엔터 전송이 없네" as "Enter should send" and built Enter-to-send on
 * top of that reading. The owner has since clarified: Enter-as-newline was
 * always the intended behaviour, and the actual complaint is that the
 * composer does not rise above the on-screen keyboard, so the Send button is
 * unreachable — a separate defect, fixed elsewhere.
 *
 * Enter-to-send is not merely unwanted here, it is unaffordable on a phone.
 * React Native's `TextInputKeyPressEventData` is `{ key: string }` with no
 * modifier flags, and an iOS software keyboard has no Shift+Return, so there
 * is no way to build the Shift+Enter escape hatch that makes Enter-to-send
 * tolerable on a desktop client. Making Enter send would mean a user simply
 * cannot type a newline. The Send button stays the only way to send.
 *
 * `onSubmitEditing` is deliberately NOT wired on the composer. A `multiline`
 * TextInput never raises it on iOS, and `blurOnSubmit={false}` suppresses it
 * on Android, so `onSubmitEditing={send}` would be a line that reads as live
 * wiring and never fires. Its absence is intentional and is not what this
 * file guards.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — a Return keypress does NOT send: no bubble appears and the
 *                draft survives with the newline the platform appends
 *   boundary   — Return on an empty/whitespace-only draft also sends nothing
 *                (Enter is inert regardless of draft state, so there is no
 *                draft-dependent branch that could bring sending back)
 *   integrity  — the Send BUTTON is unaffected and still sends
 *   authz      — N/A here: `useAuthGuardedAction`'s guest-vs-authenticated
 *                branching is exercised elsewhere (`signInHang.test.tsx`);
 *                this file needs ONE session state to isolate composer wiring
 *   hostile/UTF-8 — a Korean + emoji + HTML draft round-trips through the Send
 *                button unmangled (routed through the button, since Return no
 *                longer sends anything to round-trip)
 *   very large/race — N/A: this is INPUT WIRING (which event triggers `send`),
 *                not a payload-size or concurrency question; `send`/`deliver`
 *                cover those on their own paths
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatRoomScreen } from '../screens/chat/ChatRoomScreen';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const PLACEHOLDER = 'openstoa.chat.messagePlaceholder';

beforeEach(() => {
  // Every network call answers emptily and immediately — same stub shape as
  // `chatRoomScreen.test.tsx`. The subject here is composer WIRING, not what
  // `deliver()` eventually does with the network.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findComposer(root: any): any {
  return root.findAll(
    (n: any) => typeof n.type === 'string' && n.type === 'TextInput' && n.props.placeholder === PLACEHOLDER,
  )[0];
}

async function typeDraft(composer: ReturnType<typeof findComposer>, text: string): Promise<void> {
  await act(async () => {
    composer.props.onChangeText?.(text);
  });
  await flush();
}

/*
 * The real iOS order for Return on a multiline field: the key event first (if
 * anything is listening at all — the composer deliberately has no
 * `onKeyPress`, so `?.` makes this a no-op today), then the text change the
 * platform makes from it. Firing only the key event would test nothing, since
 * an absent handler cannot do anything; the follow-up change is what carries
 * the assertion, and it is also what a re-added Enter-to-send latch would
 * swallow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pressReturn(root: any, draft: string): Promise<void> {
  await act(async () => {
    findComposer(root).props.onKeyPress?.({ nativeEvent: { key: 'Enter' } });
  });
  await flush();
  await typeDraft(findComposer(root), `${draft}\n`);
}

describe('ChatRoomScreen composer — Return inserts a newline, it does not send', () => {
  it('CONTRACT: Return does not send, and the draft keeps its newline', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    const composer = findComposer(rendered.root);
    expect(composer, 'composer TextInput not found').toBeDefined();
    await typeDraft(composer, 'hello from the composer');

    await pressReturn(rendered.root, 'hello from the composer');

    // `send()` clears the draft synchronously before `deliver()` is awaited,
    // so a still-populated composer is a reliable, fast "nothing was sent".
    expect(
      findComposer(rendered.root).props.value,
      'the draft was cleared — Return reached send()',
    ).toBe('hello from the composer\n');
    // `send()` also appends the optimistic bubble synchronously, so its
    // absence is the second, independent witness that nothing was sent.
    expect(
      rendered.text(),
      'an optimistic message bubble appeared — Return reached send()',
    ).not.toContain('hello from the composer');

    rendered.unmount();
  });

  it('BOUNDARY: Return on an empty/whitespace-only draft also sends nothing', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    await typeDraft(findComposer(rendered.root), '   ');
    await pressReturn(rendered.root, '   ');

    // Enter is inert regardless of what is drafted: no branch on `draft.trim()`
    // exists to send here, so the newline simply lands like any other keystroke.
    expect(findComposer(rendered.root).props.value).toBe('   \n');

    rendered.unmount();
  });

  it('INTEGRITY: the Send BUTTON still works', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    await typeDraft(findComposer(rendered.root), 'sent via the button');
    const sendButton = rendered.pressableWith('openstoa.chat.send');
    expect(sendButton).toBeDefined();

    await rendered.press(sendButton!);

    expect(findComposer(rendered.root).props.value).toBe('');
    expect(rendered.text()).toContain('sent via the button');

    rendered.unmount();
  });

  it('HOSTILE/UTF-8: a Korean + emoji draft round-trips through Send unmangled', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    const text = '회의방 알림 🎉 <script>alert(1)</script>';
    await typeDraft(findComposer(rendered.root), text);
    await rendered.press(rendered.pressableWith('openstoa.chat.send')!);

    expect(rendered.text()).toContain(text);

    rendered.unmount();
  });
});
