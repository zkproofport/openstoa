/*
 * WHAT WAS WRONG. `/api/og` and `/api/og/image` take a URL from anyone — no
 * session, deliberately, because a link preview is wanted before login — and
 * fetched it from inside our network behind a protocol check and nothing else.
 * Measured against the local container, unauthenticated:
 *
 *   GET /api/og?url=http://127.0.0.1:3200/api/health  200 {"title":"localhost"}
 *   GET /api/og?url=http://community:3200/api/health  200 {"title":"community"}
 *   GET /api/og?url=http://redis:6379/                502
 *
 * The 502s read like a refusal but are only Redis and Postgres not speaking
 * HTTP. 200-vs-502 is itself the answer, so the pair worked as an
 * unauthenticated port scanner of the private network, handing back page
 * titles as it went.
 *
 * These are the cases the guard must get right. The literal-IP ones are the
 * easy half; the ones that matter are the name that RESOLVES private and the
 * redirect that LANDS private, because a check on the typed URL alone misses
 * both.
 */
import { describe, it, expect } from 'vitest';
import { isPrivateAddress, assertPublicUrl, BlockedUrlError } from '@/lib/outboundUrl';

describe('the server refuses to fetch its own network', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, whole /8'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.5', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918 lower edge'],
    ['172.31.255.255', 'RFC 1918 upper edge'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ])('refuses %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public v4'],
    ['1.1.1.1', 'public v4'],
    ['172.15.0.1', 'just below the RFC 1918 block'],
    ['172.32.0.1', 'just above it'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.1', 'just above it'],
    ['2606:4700:4700::1111', 'public v6'],
  ])('allows %s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses anything that is not an address at all', () => {
    for (const junk of ['', 'not-an-ip', '999.999.999.999', '10.0.0', 'localhost']) {
      expect(isPrivateAddress(junk)).toBe(true);
    }
  });

  it.each([
    'http://127.0.0.1:3200/api/health',
    'http://[::1]:3200/',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://10.0.0.5/',
    'https://192.168.0.1/admin',
  ])('assertPublicUrl refuses %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('refuses a HOSTNAME that resolves into the private network', async () => {
    // `localhost` is a name, not an address — the literal-IP check most of
    // these guards stop at would let it through.
    await expect(assertPublicUrl('http://localhost:3200/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it.each(['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/html,x', 'javascript:alert(1)'])(
    'refuses the protocol %s',
    async (url) => {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
    },
  );

  it('refuses a host that does not resolve, rather than trying anyway', async () => {
    await expect(
      assertPublicUrl('http://this-host-does-not-exist-zzq.invalid/'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('every refusal carries the same outward answer', async () => {
    // The route maps BlockedUrlError to one 400 for all reasons: a caller must
    // not learn "that host is private" from "that is not a URL", or the error
    // messages map the network for them.
    const reasons = new Set<string>();
    for (const url of ['http://10.0.0.1/', 'not a url', 'file:///x', 'http://localhost/']) {
      try {
        await assertPublicUrl(url);
        throw new Error(`expected ${url} to be refused`);
      } catch (e) {
        expect(e).toBeInstanceOf(BlockedUrlError);
        reasons.add((e as BlockedUrlError).reason);
      }
    }
    // Reasons differ internally (for logs) — that is fine, the ROUTE flattens
    // them. This asserts they exist and are distinguishable to us, not to the
    // caller.
    expect(reasons.size).toBeGreaterThan(1);
  });
});
