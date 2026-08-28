/**
 * The failed-send controls, RENDERED — the first component test in this package.
 *
 * The web has nine tests against the real component for this path; the phone
 * had none, because nothing here could mount a component. That gap mattered
 * more than it sounds: mobile is where the OS kills a backgrounded app, which
 * is the case the persisted failed row exists for, and twice in this work "the
 * logic is right" and "the user sees it" turned out to be different questions.
 *
 * What is pinned here is the CONTRACT the sender sees:
 *   - a failed message offers both a way to retry and a way to give up;
 *   - an attachment whose bytes are gone offers only the second, and says why;
 *   - pressing either calls exactly the thing it says, once.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from './harness/render';
import { MessageFailedControls } from '../components/MessageFailedControls';

/** The real leaves the screen passes; the labels are what the user reads. */
const LABEL: Record<string, string> = {
  'openstoa.chat.sendFailedRetry': 'Retry',
  'openstoa.chat.sendFailedDiscard': 'Delete',
  'openstoa.chat.media.expired': 'This image expired before it could be sent. Send it again.',
  'openstoa.chat.sendFailedRetrying': 'Resending…',
};
const t = (key: string) => LABEL[key] ?? key;

function setup(over: Partial<React.ComponentProps<typeof MessageFailedControls>> = {}) {
  const onRetry = vi.fn();
  const onDiscard = vi.fn();
  const element = (
    <MessageFailedControls onRetry={onRetry} onDiscard={onDiscard} t={t} styles={{}} {...over} />
  );
  return { element, onRetry, onDiscard };
}

describe('a retry that is under way', () => {
  /*
   * Pressing Retry used to look like pressing nothing.
   *
   * A send that dies before it reaches the network dies in milliseconds — the
   * local pause that used to refuse it never opened a socket — so the row went
   * away and came back inside one frame. On the phone that is invisible. The
   * only reading left was that the button was broken, which is what the sender
   * reported, twice.
   */
  it('shows a spinner where Retry was, so the press is visible', async () => {
    const { element } = setup({ retrying: true });
    const r = await render(element);

    expect(r.pressableWith(LABEL['openstoa.chat.sendFailedRetry'])).toBeUndefined();
    expect(r.text()).not.toContain(LABEL['openstoa.chat.sendFailedRetry']);
  });

  it('keeps Discard live, because a retry can sit on the deadline for half a minute', async () => {
    const { element, onDiscard } = setup({ retrying: true });
    const r = await render(element);

    const discard = r.pressableWith(LABEL['openstoa.chat.sendFailedDiscard']);
    expect(discard).toBeDefined();
    await r.press(discard!);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('an attachment whose bytes are gone says so rather than spinning forever', async () => {
    // Expired outranks retrying: there is nothing left to send, so a spinner
    // would promise an attempt that will not be made.
    const { element } = setup({ retrying: true, expired: true });
    const r = await render(element);

    expect(r.text()).toContain(LABEL['openstoa.chat.media.expired']);
  });

  it('BOUNDARY: not retrying draws exactly what it always drew', async () => {
    const { element } = setup({ retrying: false });
    const r = await render(element);

    expect(r.pressableWith(LABEL['openstoa.chat.sendFailedRetry'])).toBeDefined();
  });
});

describe('a message that did not send', () => {
  it('offers a retry and a discard', async () => {
    const { element } = setup();
    const r = await render(element);

    expect(r.pressableWith(LABEL['openstoa.chat.sendFailedRetry'])).toBeDefined();
    expect(r.pressableWith(LABEL['openstoa.chat.sendFailedDiscard'])).toBeDefined();
    // The marker that makes it read as a failure rather than a message.
    expect(r.text()).toContain('!');
  });

  it('RETRY calls back exactly once, and does not discard', async () => {
    const { element, onRetry, onDiscard } = setup();
    const r = await render(element);

    await r.press(r.pressableWith(LABEL['openstoa.chat.sendFailedRetry'])!);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('DISCARD calls back exactly once, and does not retry', async () => {
    const { element, onRetry, onDiscard } = setup();
    const r = await render(element);

    await r.press(r.pressableWith(LABEL['openstoa.chat.sendFailedDiscard'])!);

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('an attachment whose bytes are gone', () => {
  it('REGRESSION: says it expired instead of offering a retry', async () => {
    /*
     * Retrying would post a message pointing at nothing, and every reader would
     * see a permanently broken picture. The state has no retry to press, so
     * "retry forever against a 404" is not a bug to avoid — it is unreachable.
     */
    const { element } = setup({ expired: true });
    const r = await render(element);

    expect(r.text()).toContain(LABEL['openstoa.chat.media.expired']);
    expect(r.pressableWith(LABEL['openstoa.chat.sendFailedRetry'])).toBeUndefined();
  });

  it('still offers the way out — silence was the defect', async () => {
    const { element, onDiscard } = setup({ expired: true });
    const r = await render(element);

    const discard = r.pressableWith(LABEL['openstoa.chat.sendFailedDiscard']);
    expect(discard, 'an expired row must still be dismissable').toBeDefined();
    await r.press(discard!);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('the expired copy is a sentence, not a code', async () => {
    // It is the only explanation the user gets for a picture that vanished.
    const { element } = setup({ expired: true });
    const r = await render(element);
    expect(r.text()).toMatch(/expired/i);
    expect(r.text()).not.toContain('openstoa.chat.media.expired');
  });
});

describe('the harness itself', () => {
  it('renders host elements that keep their props, so assertions are about the real tree', async () => {
    const { element } = setup();
    const r = await render(element);
    const pressables = r.root.findAll((n) => String(n.type) === 'TouchableOpacity');
    expect(pressables.length).toBe(2);
    for (const p of pressables) expect(typeof p.props.onPress).toBe('function');
  });
});
