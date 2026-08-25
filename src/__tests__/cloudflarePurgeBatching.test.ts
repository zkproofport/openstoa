/**
 * One purge client, batching itself, behind the outbound deadline.
 *
 * WHAT WAS WRONG. `purgeCloudflareUrls` threw when handed more than the 30 URLs
 * Cloudflare accepts per call and told the caller to split the list. So both
 * maintenance scripts that actually purge grew their own copy of the function —
 * built on a bare `fetch`, with no deadline. Three implementations of one rule,
 * and the test that enforces the deadline pointed at the one nothing imported.
 *
 * The failure that leaves: a Cloudflare that accepts the connection and never
 * answers hangs a sweep of thousands of objects with nothing to stop it, and
 * every object it never reached keeps serving stale bytes for the full
 * year-long max-age.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   boundary  → 0, 1, exactly 30, 31, and a large sweep
 *   contract  → over the limit BATCHES rather than throwing
 *   contract  → every batch carries the zone, the token and the URLs
 *   integrity → batches partition the input: no URL dropped, none purged twice
 *   external  → a rejected batch throws and does not silently report success
 *   empty     → an empty list makes no call at all
 *   env       → a missing zone or token fails loudly rather than no-opping
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLOUDFLARE_PURGE_BATCH,
  CloudflarePurgeError,
  purgeCloudflareUrls,
} from '@/lib/cloudflare-cache';

const OK = { ok: true, status: 200, text: async () => JSON.stringify({ success: true, errors: [] }) };

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://cdn.example/o/${i}.bin`);
}

/** Every `files` array the client sent, in order. */
function sentBatches(fetchMock: ReturnType<typeof vi.fn>): string[][] {
  return fetchMock.mock.calls.map(
    (c) => (JSON.parse((c[1] as RequestInit).body as string) as { files: string[] }).files,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CLOUDFLARE_ZONE_ID = 'zone-1';
  process.env.CLOUDFLARE_PURGE_TOKEN = 'token-1';
  fetchMock = vi.fn(async () => OK as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.CLOUDFLARE_PURGE_TOKEN;
});

describe('purging more than Cloudflare accepts in one call', () => {
  it('EMPTY: nothing to purge makes no call at all', async () => {
    await purgeCloudflareUrls([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('BOUNDARY: one URL is one call', async () => {
    await purgeCloudflareUrls(urls(1));
    expect(sentBatches(fetchMock)).toEqual([['https://cdn.example/o/0.bin']]);
  });

  it('BOUNDARY: exactly the limit is still ONE call', async () => {
    await purgeCloudflareUrls(urls(CLOUDFLARE_PURGE_BATCH));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: one over the limit batches instead of throwing', async () => {
    // Throwing here is what pushed both scripts into writing their own copy.
    await purgeCloudflareUrls(urls(CLOUDFLARE_PURGE_BATCH + 1));
    const batches = sentBatches(fetchMock);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(CLOUDFLARE_PURGE_BATCH);
    expect(batches[1]).toHaveLength(1);
  });

  it('INTEGRITY: a large sweep is partitioned — nothing dropped, nothing sent twice', async () => {
    const all = urls(1000);
    await purgeCloudflareUrls(all);
    const flat = sentBatches(fetchMock).flat();
    expect(flat).toEqual(all);
    expect(new Set(flat).size).toBe(all.length);
    expect(sentBatches(fetchMock).every((b) => b.length <= CLOUDFLARE_PURGE_BATCH)).toBe(true);
  });

  it('CONTRACT: every call carries the zone and the token', async () => {
    await purgeCloudflareUrls(urls(61));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain('/zones/zone-1/purge_cache');
      expect((init as RequestInit).method).toBe('POST');
      expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
        'Bearer token-1',
      );
    }
  });

  it('EXTERNAL FAILURE: a rejected batch throws rather than reporting success', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }) as unknown as Response);
    await expect(purgeCloudflareUrls(urls(5))).rejects.toBeInstanceOf(CloudflarePurgeError);
  });

  it('EXTERNAL FAILURE: a 200 that says success:false is still a failure', async () => {
    /*
     * Cloudflare answers 200 with `success: false` for a rejected purge, so a
     * client that only checks the status code reports a purge that never
     * happened — and the stale bytes stay served for a year.
     */
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: false, errors: [{ code: 1012, message: 'nope' }] }),
    }) as unknown as Response);
    await expect(purgeCloudflareUrls(urls(1))).rejects.toThrow(/1012/);
  });

  it('ENV: a missing zone or token fails loudly, never silently no-ops', async () => {
    // A quiet skip would leave the operator believing the cache was cleared.
    delete process.env.CLOUDFLARE_ZONE_ID;
    await expect(purgeCloudflareUrls(urls(1))).rejects.toThrow(/CLOUDFLARE_ZONE_ID/);
    process.env.CLOUDFLARE_ZONE_ID = 'zone-1';
    delete process.env.CLOUDFLARE_PURGE_TOKEN;
    await expect(purgeCloudflareUrls(urls(1))).rejects.toThrow(/CLOUDFLARE_PURGE_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
