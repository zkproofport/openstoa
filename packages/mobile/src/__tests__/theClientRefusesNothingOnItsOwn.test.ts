/**
 * The client never refuses a request on its own. Only the loops that repeat
 * by themselves stand down while the edge is banning us.
 *
 * WHAT HAPPENED, twice, on the same iPhone. A local pause was added to stop the
 * app feeding a ban it had caused, and it went in the one place every request
 * passes. The first time it ate a chat message outright. The exemption written
 * for that only covered the POST that carries the message — so the second time,
 * sealing the message first fetched the room's newest commits, THAT was still
 * refused, sealing threw, and the send died with no request in the edge log at
 * all. From the outside both look identical: a bubble with Resend beside it and
 * nothing on the wire.
 *
 * Exempting calls one at a time cannot work. A tap is a chain — catch up on
 * commits, seal, upload media, post — and the transport cannot know which links
 * belong to which tap. So the gate is gone. `rateLimitedUntil()` still reports
 * the pause, and the one thing that actually floods, the key-backup retry
 * ladder, still asks before it fires.
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
const tooMany = (retryAfter?: string) =>
  new Response('', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

/** Get the client into a paused state, and report how many requests that cost. */
async function pause(client: OpenStoaClient, sent: () => number): Promise<number> {
  await client.get('/api/topics').catch(() => {});
  expect(rateLimitedUntil()).toBeGreaterThan(Date.now());
  return sent();
}

describe('the client refuses nothing on its own', () => {
  beforeEach(() => {
    clearRateLimitPause();
    vi.unstubAllGlobals();
  });

  it('THE DEFECT: every step of a send reaches the server during the pause', async () => {
    /*
     * The real chain, in the order the chat screen runs it. Before this fix the
     * first two were refused locally, so the fourth never happened — and the
     * exemption written the first time round only covered the fourth.
     */
    const chain = [
      '/api/topics/t/mls/commit?sinceEpoch=2', // catch up before sealing
      '/api/topics/t/tak/bundles',             // room key for the push preview
      '/api/topics/t/archive/root',            // archive root
      '/api/topics/t/chat',                    // the message itself
    ];
    const seen: string[] = [];
    let refuse = true;
    const client = clientWith(async (input) => {
      seen.push(String(input).replace('https://openstoa.test', ''));
      return refuse ? tooMany() : ok({ message: { id: 'm1' } });
    });

    await pause(client, () => seen.length);
    refuse = false; // the ban has lifted; the guessed pause has not expired
    seen.length = 0;

    for (const path of chain) await client.get(path);
    expect(seen).toEqual(chain);
  });

  it('a request refused by the edge still reports the rate limit, not a generic error', async () => {
    const client = clientWith(async () => tooMany());
    await expect(client.post('/api/topics/t/chat', { x: 1 })).rejects.toBeInstanceOf(
      OpenStoaRateLimitedError,
    );
  });

  it('CONTRACT: the pause is still recorded, because the retry ladder reads it', async () => {
    const client = clientWith(async () => tooMany('30'));
    await client.get('/api/topics').catch(() => {});
    const until = rateLimitedUntil();
    expect(until).toBeGreaterThan(Date.now() + 25_000);
    expect(until).toBeLessThan(Date.now() + 35_000);
  });

  it('CONTRACT: no Retry-After means the documented five minutes, not a shorter guess', async () => {
    const client = clientWith(async () => tooMany());
    await client.get('/api/topics').catch(() => {});
    expect(rateLimitedUntil()).toBeGreaterThan(Date.now() + 290_000);
  });

  it('one success clears the pause, so the ladder restarts without waiting out a guess', async () => {
    let refuse = true;
    const client = clientWith(async () => (refuse ? tooMany() : ok({ ok: true })));
    await pause(client, () => 0);
    refuse = false;
    await client.get('/api/topics');
    expect(rateLimitedUntil()).toBe(0);
  });

  it('REPETITION: fifty calls during the pause all go out — the transport holds nobody back', async () => {
    let sent = 0;
    let refuse = true;
    const client = clientWith(async () => {
      sent += 1;
      return refuse ? tooMany() : ok({ ok: true });
    });
    await pause(client, () => sent);
    refuse = false;
    sent = 0;
    for (let i = 0; i < 50; i += 1) await client.get(`/api/topics?page=${i}`);
    expect(sent).toBe(50);
  });

  it('BOUNDARY: with no pause at all, nothing about a request changes', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });
    await client.post('/api/topics/t/chat', { x: 1 });
    expect(sent).toBe(1);
    expect(rateLimitedUntil()).toBe(0);
  });
});
