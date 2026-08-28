/**
 * The local rate-limit pause must never swallow something a person tapped.
 *
 * WHAT HAPPENED, on an iPhone 2026-08-28. The pause was added the day before to
 * stop the app re-arming its own ban, and it went in the one place every
 * request passes — which included Send. Someone typed a message, tapped Send,
 * and it never left the phone: the load balancer log for that minute holds no
 * `POST /chat` at all, only the 429s that had set the pause seconds earlier. An
 * image sent moments before had gone through fine, which is what makes the
 * shape unmistakable — nothing was wrong with the room, the keys or the
 * network.
 *
 * The pause is worth keeping for REPEATING work, which is what floods. One tap
 * is one request, and the pause length is a GUESS: five minutes whenever the
 * edge sends no `Retry-After`. Refusing a person's action on a guess trades
 * their message for nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@openstoa/miniapp-bridge';
import {
  clearRateLimitPause,
  OpenStoaClient,
  OpenStoaRateLimitedError,
  rateLimitedUntil,
} from '../api/openstoaClient';

function clientWith(fetchImpl: typeof fetch): OpenStoaClient {
  vi.stubGlobal('fetch', fetchImpl);
  const host = {
    getEnvironment: () => ({
      isEmbedded: true,
      hostName: 'test',
      openstoaBaseUrl: 'https://openstoa.test',
    }),
    getOpenStoaToken: async () => null,
    setOpenStoaToken: async () => {},
    logoutFromOpenStoa: async () => {},
  } as unknown as HostApi;
  return new OpenStoaClient({ host });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const tooMany = () => new Response('', { status: 429 });

/** Get the client into a paused state, and report how many requests that cost. */
async function pause(client: OpenStoaClient, sent: () => number): Promise<number> {
  await client.get('/api/topics').catch(() => {});
  expect(rateLimitedUntil()).toBeGreaterThan(Date.now());
  return sent();
}

describe("a person's tap is never swallowed", () => {
  beforeEach(() => {
    clearRateLimitPause();
    vi.unstubAllGlobals();
  });

  it('THE DEFECT: a send during the pause still reaches the server', async () => {
    let sent = 0;
    let refuse = true;
    const client = clientWith(async () => {
      sent += 1;
      return refuse ? tooMany() : ok({ message: { id: 'm1' } });
    });

    const spent = await pause(client, () => sent);
    refuse = false; // the ban has actually lifted; the pause has not expired

    await client.post('/api/topics/t/chat', { ciphertext: 'x' }, { userInitiated: true });
    expect(sent).toBe(spent + 1);
  });

  it('CONTRACT: background work during the pause still sends nothing', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return tooMany();
    });

    const spent = await pause(client, () => sent);
    await client.get('/api/topics/t/chat').catch(() => {});
    await client.post('/api/diag/e2ee', { step: 'x' }).catch(() => {});
    expect(sent).toBe(spent);
  });

  it('REPETITION: twenty background calls stay held while twenty taps go out', async () => {
    let sent = 0;
    let refuse = true;
    const client = clientWith(async () => {
      sent += 1;
      return refuse ? tooMany() : ok({ ok: true });
    });

    const spent = await pause(client, () => sent);
    refuse = false;

    for (let i = 0; i < 20; i += 1) {
      await client.get(`/api/topics?page=${i}`).catch(() => {});
    }
    expect(sent).toBe(spent); // background: nothing

    for (let i = 0; i < 20; i += 1) {
      await client.post(`/api/topics/t/chat`, { n: i }, { userInitiated: true });
    }
    expect(sent).toBe(spent + 20); // taps: every one of them
  });

  it('a tap that is itself refused reports the rate limit rather than a generic error', async () => {
    const client = clientWith(async () => tooMany());
    await expect(
      client.post('/api/topics/t/chat', { x: 1 }, { userInitiated: true }),
    ).rejects.toBeInstanceOf(OpenStoaRateLimitedError);
  });

  it('CONTRACT: a tap that succeeds clears the pause for everyone', async () => {
    let refuse = true;
    const client = clientWith(async () => (refuse ? tooMany() : ok({ ok: true })));

    await pause(client, () => 0);
    refuse = false;

    await client.post('/api/topics/t/chat', { x: 1 }, { userInitiated: true });
    expect(rateLimitedUntil()).toBe(0);

    // and background work is moving again, without waiting out the guess
    let sent = 0;
    const client2 = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });
    await client2.get('/api/topics');
    expect(sent).toBe(1);
  });

  it('BOUNDARY: with no pause at all, a tap behaves like anything else', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });
    await client.post('/api/topics/t/chat', { x: 1 }, { userInitiated: true });
    expect(sent).toBe(1);
    expect(rateLimitedUntil()).toBe(0);
  });
});
