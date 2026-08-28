/**
 * The app must not spend its own request budget banning itself.
 *
 * WHAT HAPPENED, measured through the load balancer on 2026-08-27. The edge
 * allows a hundred requests a minute per address and then refuses for five
 * minutes. Three independent parts of the mini-app read the same two backup
 * rows on their own schedules — `/api/keys/backup` went out FIVE times inside
 * three seconds — so the phone crossed the limit on its own, and every retry
 * during the ban renewed it. On screen: "Something went wrong. Please try
 * again", in English, telling the person to do the one thing that keeps it
 * broken.
 *
 * The repetition cases are the point. One read is never the problem; the
 * question is what N readers asking at once cost, and what N retries during a
 * ban cost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@openstoa/miniapp-bridge';
import {
  clearRateLimitPause,
  OpenStoaClient,
  OpenStoaRateLimitedError,
  rateLimitedUntil,
} from '../api/openstoaClient';
import { backupMayRunNow } from '../crypto/mobileTransport';

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
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the app does not ban itself', () => {
  beforeEach(() => {
    clearRateLimitPause();
    vi.unstubAllGlobals();
  });

  it('THE DEFECT: five readers of the same path cost ONE request', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      // Settle on a later turn so all five callers are genuinely in flight.
      await new Promise((r) => setTimeout(r, 5));
      return ok({ ok: true });
    });

    await Promise.all(Array.from({ length: 5 }, () => client.get('/api/keys/backup')));
    expect(sent).toBe(1);
  });

  it('REPETITION: fifty simultaneous readers still cost ONE request', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      await new Promise((r) => setTimeout(r, 5));
      return ok({ ok: true });
    });

    await Promise.all(Array.from({ length: 50 }, () => client.get('/api/keys/backup')));
    expect(sent).toBe(1);
  });

  it('THE REAL SHAPE: fifty-six reads ONE AFTER ANOTHER cost one request', async () => {
    /*
     * This is what the load balancer actually recorded — a render cascade, each
     * read starting after the last finished. Sharing a flight does nothing for
     * it, which is why the first fix did not move the number.
     */
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });

    for (let i = 0; i < 56; i += 1) await client.get('/api/keys/backup');
    expect(sent).toBe(1);
  });

  it('BOUNDARY: the memory is short — a read two seconds later asks again', async () => {
    /*
     * The window exists to swallow a render cascade, which the load balancer
     * measured at 0.26-0.79 seconds between reads. It must NOT become a cache:
     * another device can write this row, and a stale answer about whether the
     * account has a backup is exactly the kind of false reassurance this
     * project keeps having to remove.
     */
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });

    await client.get('/api/keys/backup');
    await new Promise((r) => setTimeout(r, 2_100));
    await client.get('/api/keys/backup');
    expect(sent).toBe(2);
  });

  it('CONTRACT: a write to the key rows makes the next read ask again', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });

    await client.get('/api/keys/backup');
    await client.post('/api/keys/tak-backup', { ciphertext: 'x' });
    await client.get('/api/keys/backup');
    // one read, one write, then a read that must NOT come from memory
    expect(sent).toBe(3);
  });

  it('INTEGRITY: a path outside the named two is never remembered', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return ok({ ok: true });
    });

    await client.get('/api/topics');
    await client.get('/api/topics');
    expect(sent).toBe(2);
  });

  it('INTEGRITY: different paths are never shared with each other', async () => {
    const seen: string[] = [];
    const client = clientWith(async (input) => {
      seen.push(String(input));
      await new Promise((r) => setTimeout(r, 5));
      return ok({ ok: true });
    });

    await Promise.all([client.get('/api/keys/tak-backup'), client.get('/api/keys/backup')]);
    expect(seen).toHaveLength(2);
  });

  it('THE BAN: a 429 raises a rate-limited error, not a generic one', async () => {
    const client = clientWith(async () => new Response('', { status: 429 }));
    await expect(client.get('/api/topics')).rejects.toBeInstanceOf(OpenStoaRateLimitedError);
  });

  it('THE BAN: its message is Korean and does not say "try again now"', async () => {
    const client = clientWith(async () => new Response('', { status: 429 }));
    const err = (await client.get('/api/topics').catch((e) => e)) as Error;
    expect(err.message).toMatch(/잠시/);
    expect(err.message).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('THE RESTRAINT: the retry ladder stands down while the edge is banning us', async () => {
    /*
     * `backupMayRunNow` is the REAL decision both retry paths make, imported
     * rather than reproduced. It was reproduced for exactly one commit, and
     * deleting the real three lines left all 1 470 tests green — the app's only
     * brake on a ban, entirely unguarded. Import it or this proves nothing.
     *
     * A blanket refusal in the transport stood alongside it for a day and
     * swallowed two chat messages before it came out (see
     * `theClientRefusesNothingOnItsOwn`). The ladder is what floods, so the
     * ladder is what asks, and now it is the only thing that does.
     */
    const client = clientWith(async () => new Response('', { status: 429 }));
    await client.get('/api/topics').catch(() => {});
    const until = rateLimitedUntil();
    expect(until).toBeGreaterThan(Date.now());

    for (let i = 0; i < 20; i += 1) expect(backupMayRunNow()).toBe(false);

    // BOUNDARY: the instant the ban expires, and one millisecond either side.
    expect(backupMayRunNow(until - 1)).toBe(false);
    expect(backupMayRunNow(until)).toBe(true);
    expect(backupMayRunNow(until + 1)).toBe(true);

    clearRateLimitPause();
    expect(backupMayRunNow()).toBe(true);
  });

  it('CONTRACT: with no ban recorded at all, the ladder runs', () => {
    clearRateLimitPause();
    expect(rateLimitedUntil()).toBe(0);
    expect(backupMayRunNow()).toBe(true);
  });

  it('CONTRACT: ordinary requests are NOT held back — only the ladder is', async () => {
    let sent = 0;
    const client = clientWith(async () => {
      sent += 1;
      return new Response('', { status: 429 });
    });

    await client.get('/api/topics').catch(() => {});
    expect(sent).toBe(1);

    for (let i = 0; i < 20; i += 1) {
      await client.get(`/api/topics?page=${i}`).catch(() => {});
    }
    expect(sent).toBe(21); // every one went out; the edge decides, not the app
  });

  it('CONTRACT: the pause honours Retry-After when the edge sends one', async () => {
    const client = clientWith(
      async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const before = Date.now();
    await client.get('/api/topics').catch(() => {});
    const until = rateLimitedUntil();
    expect(until - before).toBeGreaterThanOrEqual(29_000);
    expect(until - before).toBeLessThanOrEqual(31_000);
  });

  it('BOUNDARY: no Retry-After falls back to the documented five minutes, not less', async () => {
    const client = clientWith(async () => new Response('', { status: 429 }));
    const before = Date.now();
    await client.get('/api/topics').catch(() => {});
    expect(rateLimitedUntil() - before).toBeGreaterThanOrEqual(299_000);
  });

  it('a launch with no 429 never reports a pause', async () => {
    const client = clientWith(async () => ok({ ok: true }));
    await client.get('/api/topics');
    expect(rateLimitedUntil()).toBe(0);
  });
});
