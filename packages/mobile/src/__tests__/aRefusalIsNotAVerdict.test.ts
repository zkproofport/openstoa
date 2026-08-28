/**
 * Being refused by our own edge is not an answer about the thing we asked for.
 *
 * WHAT HAPPENED, on an iPhone 2026-08-28. Opening one room spent 69 requests
 * against a limit of 100 a minute, so the tail of the burst came back 429 — and
 * among the refused was the link preview. The preview treats any failure as
 * "this site has none" and remembers that for an hour, so a Claude link lost
 * its card outright. A Naver place link lost only its picture, which is the
 * clearer proof: the scrape itself had SUCCEEDED, title and review counts and
 * all, and only the image fetch was refused. Beside the same link in KakaoTalk
 * the difference was one large photo.
 *
 * A site that genuinely has no preview must still be remembered — asking again
 * repeats a question already answered. Only our own refusal is worth retrying.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@openstoa/miniapp-bridge';
import {
  EDGE_REFUSAL_RETRIES,
  edgeRefusalRetryDelayMs,
  isEdgeRefusal,
  OpenStoaApiError,
  OpenStoaClient,
  OpenStoaRateLimitedError,
  clearRateLimitPause,
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

describe('a refusal is not a verdict', () => {
  it('THE DEFECT: a real 429 off the wire is recognised as our edge refusing us', async () => {
    // Constructed by the client from an actual response, not hand-built — a
    // hand-built error would pass even if the client stopped raising this type.
    clearRateLimitPause();
    const client = clientWith(async () => new Response('', { status: 429 }));
    const err = await client.get('/api/og?url=https%3A%2F%2Fexample.test').catch((e) => e);
    expect(err).toBeInstanceOf(OpenStoaRateLimitedError);
    expect(isEdgeRefusal(err)).toBe(true);
  });

  it('CONTRACT: a site that really has no preview is NOT retried', async () => {
    // The reddit case: the server answers, and the answer is "nothing here".
    clearRateLimitPause();
    const client = clientWith(async () => new Response('upstream refused', { status: 502 }));
    const err = await client.get('/api/og?url=https%3A%2F%2Freddit.test').catch((e) => e);
    expect(err).toBeInstanceOf(OpenStoaApiError);
    expect(isEdgeRefusal(err)).toBe(false);
  });

  it('INTEGRITY: nothing else counts as a refusal — not null, not a plain Error', () => {
    for (const other of [null, undefined, 'rate limited', 429, new Error('429'), {}]) {
      expect(isEdgeRefusal(other)).toBe(false);
    }
  });

  it('BOUNDARY: it asks again a few times and then stops', () => {
    const refusal = new OpenStoaRateLimitedError('/api/og', Date.now() + 300_000);
    const askAgain = (count: number) => isEdgeRefusal(refusal) && count < EDGE_REFUSAL_RETRIES;
    expect(askAgain(0)).toBe(true);
    expect(askAgain(EDGE_REFUSAL_RETRIES - 1)).toBe(true);
    expect(askAgain(EDGE_REFUSAL_RETRIES)).toBe(false); // and never again
    expect(askAgain(99)).toBe(false);
  });

  it('the wait grows, and stops growing — a ban outlasts a tight loop', () => {
    const waits = [0, 1, 2, 3, 4].map(edgeRefusalRetryDelayMs);
    // Each wait is longer than the last, until the ceiling.
    expect(waits[0]).toBe(5_000);
    expect(waits[1]).toBe(10_000);
    expect(waits[2]).toBe(20_000);
    expect(waits[3]).toBe(30_000); // capped
    expect(waits[4]).toBe(30_000);
    // Never instant: retrying inside the same second just renews the ban.
    for (const w of waits) expect(w).toBeGreaterThanOrEqual(5_000);
  });
});
