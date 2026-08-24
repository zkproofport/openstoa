/**
 * The composer HOLDS newlines. Nothing swallows them.
 *
 * Despite the filename, this file now pins the opposite of what it was
 * written for. It was the second half of an Enter-to-send change (a
 * `pendingNewline` latch that ate the newline iOS appends after a Return, so
 * the composer `send()` had just cleared did not immediately refill with a
 * stray blank line). That change is reverted: Return inserts a newline and
 * does not send — see `chatComposerReturnKey.test.tsx` for the send-side
 * contract. The latch is gone, and what survives here is the draft-side
 * contract it was at risk of breaking: a newline the user produces, by Return
 * or by paste, stays in the box.
 *
 * The filename is kept only because sibling lanes and notes reference this
 * path; it should be renamed to `chatComposerNewline` when the tree is quiet.
 *
 * Why this file still earns its place next to the sibling: it is the only one
 * that models BOTH events iOS raises for a Return on a multiline field — the
 * key event, then the text change the platform makes from it. A latch can
 * only be observed on that second event, so if Enter-to-send is ever re-added
 * this is where it shows up as a swallowed newline.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — the newline that follows a Return lands in the draft and
 *                stays there; nothing intercepts the text change
 *   integrity  — a PASTED multi-line draft keeps every newline verbatim,
 *                including a trailing one
 *   boundary   — Return on a whitespace-only draft behaves identically; there
 *                is no draft-dependent branch
 *   race       — N/A now: the one-change-wide latch that made ordering
 *                observable is deleted, so there is no state between two
 *                events left to get stuck
 *   authz/hostile/UTF-8/very large — N/A: same composer wiring as the sibling
 *                file, which carries the Korean+emoji probe; nothing here
 *                touches the payload or the session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from './harness/screen';
import { flush } from './harness/render';
import { useOpenStoaSession } from '../stores/sessionStore';
import { ChatRoomScreen } from '../screens/chat/ChatRoomScreen';

const TOPIC = '33333333-4444-4555-8666-777777777777';
const PLACEHOLDER = 'openstoa.chat.messagePlaceholder';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findComposer(root: any): any {
  return root.findAll(
    (n: any) => typeof n.type === 'string' && n.type === 'TextInput' && n.props.placeholder === PLACEHOLDER,
  )[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function change(root: any, text: string): Promise<void> {
  await act(async () => {
    findComposer(root).props.onChangeText?.(text);
  });
  await flush();
}

/** The real iOS order for a Return on a multiline field: key event first (the
 *  composer deliberately has no `onKeyPress`, so `?.` makes it a no-op today),
 *  then the text change the platform makes from it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function returnKeyOnDevice(root: any, draft: string): Promise<void> {
  await act(async () => {
    findComposer(root).props.onKeyPress?.({ nativeEvent: { key: 'Enter' } });
  });
  await flush();
  await change(root, `${draft}\n`);
}

describe('ChatRoomScreen composer — the newline a Return produces', () => {
  it('CONTRACT: it lands in the draft, and nothing was sent', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    await change(rendered.root, 'ship it');
    await returnKeyOnDevice(rendered.root, 'ship it');

    expect(
      findComposer(rendered.root).props.value,
      'the newline was swallowed — something is intercepting the text change',
    ).toBe('ship it\n');
    expect(
      rendered.text(),
      'a message bubble appeared — Return is sending again',
    ).not.toContain('ship it');

    rendered.unmount();
  });

  it('CONTRACT: a second Return keeps stacking newlines', async () => {
    /*
     * One Return could survive a latch that arms on the FIRST Enter only.
     * Pressing twice is what separates "newlines work" from "the first one
     * happened to get through", and it is the shape a user types when they
     * want a blank line between paragraphs.
     */
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    await change(rendered.root, 'line one');
    await returnKeyOnDevice(rendered.root, 'line one');
    await returnKeyOnDevice(rendered.root, 'line one\n');
    await change(rendered.root, 'line one\n\nline two');

    expect(findComposer(rendered.root).props.value).toBe('line one\n\nline two');
    expect(rendered.text()).not.toContain('line one');

    rendered.unmount();
  });

  it('INTEGRITY: a pasted multi-line draft is kept verbatim', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    // A paste, not a Return: no key event at all, text arrives in one change.
    await change(rendered.root, 'line one\nline two\n');

    expect(findComposer(rendered.root).props.value).toBe('line one\nline two\n');

    rendered.unmount();
  });

  it('BOUNDARY: Return on a whitespace-only draft behaves identically', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { params: { topicId: TOPIC, kind: 'topic' } });

    await change(rendered.root, '   ');
    await returnKeyOnDevice(rendered.root, '   ');

    expect(
      findComposer(rendered.root).props.value,
      'Return is behaving differently depending on the draft — it should be inert either way',
    ).toBe('   \n');

    rendered.unmount();
  });
});
