/**
 * The notification that asks a key-holder to open the app.
 *
 * Unlike every other push this server sends, this one is meant to be READ and
 * acted on: on the scoped tiers a device that just joined can read nothing
 * until a device that already holds the keys hands them over, and only that
 * device's owner can make it happen. So the wording has to say what is being
 * asked and why, and it has to be right about WHO is waiting — "a new member"
 * when it is your own phone is the sort of small wrongness that makes a
 * notification feel machine-written and ignorable.
 *
 * What it must NOT say is anything about the conversation. A lockscreen is a
 * public surface, and the rest of this server's push payloads are content-free
 * for exactly that reason.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → only sleeping devices are woken; each carries the topic and a
 *                routable `kind`
 *   integrity  → the copy names the owner's own device when it is theirs, and
 *                another member when it is not; no topic title, nickname or
 *                message content in any field
 *   boundary   → a device already streaming is not woken; an account with no
 *                stream at all has every device woken
 *   empty      → nobody asleep, and no provider configured, both send nothing
 *   external   → one dead token does not stop the rest
 *   authz      → N/A: the recipient set is the topic's member tokens, which the
 *                store scopes; this function is told who, not who may
 *   UTF-8 / very large / race → N/A: fixed copy, ids, and one integer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildKeyNeededPayload, dispatchKeyNeeded, type PushProvider } from '@/lib/push';

const TOPIC = '11111111-2222-4333-8444-555555555555';

const tokensMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pushStore', () => ({ getTopicMemberTokens: tokensMock }));

interface Sent {
  token: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

function providerSpy(): { provider: PushProvider; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    provider: {
      async send(target, payload) {
        sent.push({
          token: target.pushToken,
          title: payload.title,
          body: payload.body,
          data: payload.data as Record<string, unknown>,
        });
      },
    },
  };
}

function device(userId: string, handle: string) {
  return { userId, routingHandle: handle, pushToken: `tok-${handle}`, platform: 'ios' as const };
}

const db = { execute: async () => [] };

// Per test: `not.toHaveBeenCalled()` is meaningless against a mock that
// carries every earlier test's calls.
beforeEach(() => tokensMock.mockClear());

describe('the wording', () => {
  it('INTEGRITY: names your OWN device when the waiting one is yours', async () => {
    const own = buildKeyNeededPayload(TOPIC, 4, true);

    expect(own.title.toLowerCase()).toContain('your other device');
    expect(own.body).toContain('your other device');
    // Calling it a stranger when it is your own phone is the wrongness this
    // distinction exists to avoid.
    expect(own.title.toLowerCase()).not.toContain('member');
  });

  it('INTEGRITY: names another member when it is somebody else', async () => {
    const theirs = buildKeyNeededPayload(TOPIC, 4, false);

    expect(theirs.title.toLowerCase()).toContain('member');
    expect(theirs.title.toLowerCase()).not.toContain('your other device');
  });

  it('CONTRACT: it asks for the one thing that resolves it', async () => {
    for (const ownDevice of [true, false]) {
      const p = buildKeyNeededPayload(TOPIC, 1, ownDevice);
      // The remedy is opening the app; a notification that only states a fact
      // leaves the reader with nothing to do.
      expect(p.body.toLowerCase()).toContain('open');
      expect(p.title.trim().length).toBeGreaterThan(0);
      expect(p.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('INTEGRITY: nothing about the conversation reaches the lockscreen', async () => {
    const p = buildKeyNeededPayload(TOPIC, 4, false);
    const surface = `${p.title} ${p.body}`;

    // The topic id is data for the tap, never text — and there is no field for
    // a title, a nickname or a message, which is the whole content-free rule.
    expect(surface).not.toContain(TOPIC);
    expect(Object.keys(p.data).sort()).toEqual(['epoch', 'kind', 'topicId']);
    expect(p.data.kind).toBe('key-needed');
  });
});

describe('who gets woken', () => {
  it('CONTRACT + BOUNDARY: only the devices with no stream of their own', async () => {
    // Alice is reading on her laptop while her phone — the device that holds
    // the keys — is asleep. Waking the phone is the entire point.
    tokensMock.mockResolvedValueOnce([device('alice', 'laptop'), device('alice', 'phone')]);
    const { provider, sent } = providerSpy();

    await dispatchKeyNeeded(
      db,
      TOPIC,
      2,
      new Map([['alice', new Set(['laptop'])]]),
      provider,
      'bob',
    );

    expect(sent.map((s) => s.token)).toEqual(['tok-phone']);
  });

  it('INTEGRITY: the copy is chosen per recipient, not per broadcast', async () => {
    tokensMock.mockResolvedValueOnce([device('alice', 'a1'), device('bob', 'b1')]);
    const { provider, sent } = providerSpy();

    // Bob's device is the one that joined, so Bob reads "your other device"
    // while Alice reads "a new member" — from the same fan-out.
    await dispatchKeyNeeded(
      db,
      TOPIC,
      2,
      new Map([
        ['alice', new Set<string>()],
        ['bob', new Set<string>()],
      ]),
      provider,
      'bob',
    );

    const byToken = Object.fromEntries(sent.map((s) => [s.token, s.title]));
    expect(byToken['tok-b1'].toLowerCase()).toContain('your other device');
    expect(byToken['tok-a1'].toLowerCase()).toContain('member');
  });

  it('BOUNDARY: an account with nothing open has every device woken', async () => {
    tokensMock.mockResolvedValueOnce([device('alice', 'a1'), device('alice', 'a2')]);
    const { provider, sent } = providerSpy();

    await dispatchKeyNeeded(db, TOPIC, 1, new Map([['alice', new Set<string>()]]), provider, 'bob');

    expect(sent.map((s) => s.token).sort()).toEqual(['tok-a1', 'tok-a2']);
  });

  it('EMPTY: nobody asleep means nothing sent', async () => {
    tokensMock.mockResolvedValueOnce([device('alice', 'a1')]);
    const { provider, sent } = providerSpy();

    await dispatchKeyNeeded(db, TOPIC, 1, new Map([['alice', new Set(['a1'])]]), provider, 'bob');

    expect(sent).toEqual([]);
  });

  it('EMPTY: no provider configured is a clean no-op', async () => {
    await expect(
      dispatchKeyNeeded(db, TOPIC, 1, new Map([['alice', new Set<string>()]]), null, 'bob'),
    ).resolves.toBeUndefined();
    expect(tokensMock).not.toHaveBeenCalled();
  });

  it('INTEGRITY: a device of an account nobody asked about is left alone', async () => {
    // The token read is topic-wide; the recipient set is not. Waking somebody
    // outside it would be a notification nobody decided to send.
    tokensMock.mockResolvedValueOnce([device('alice', 'a1'), device('carol', 'c1')]);
    const { provider, sent } = providerSpy();

    await dispatchKeyNeeded(db, TOPIC, 1, new Map([['alice', new Set<string>()]]), provider, 'bob');

    expect(sent.map((s) => s.token)).toEqual(['tok-a1']);
  });

  it('EXTERNAL FAILURE: one dead token does not stop the others', async () => {
    tokensMock.mockResolvedValueOnce([device('alice', 'a1'), device('alice', 'a2')]);
    const sent: string[] = [];
    const provider: PushProvider = {
      async send(target) {
        if (target.pushToken === 'tok-a1') throw new Error('unregistered');
        sent.push(target.pushToken);
      },
    };

    await expect(
      dispatchKeyNeeded(db, TOPIC, 1, new Map([['alice', new Set<string>()]]), provider, 'bob'),
    ).resolves.toBeUndefined();
    expect(sent).toEqual(['tok-a2']);
  });
});
