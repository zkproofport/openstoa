import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Where the server is allowed to make a request on a caller's behalf.
 *
 * `/api/og` and `/api/og/image` take a URL from anyone — no session, by design,
 * because a link preview is wanted before you are logged in — and fetch it from
 * inside our network. With only a protocol check, `?url=http://community:3200`
 * came back `200 {"title":"community"}`: the caller had the server read an
 * address they cannot reach themselves. Redis and Postgres answered 502, which
 * looks like a refusal but is only those services not speaking HTTP. The
 * difference between 200 and 502 is itself an answer, so the pair worked as an
 * unauthenticated port scanner of the private network, with page titles.
 *
 * Two things have to be true, and checking only the first is the usual mistake:
 *
 *  1. The hostname must RESOLVE to a public address. A name is not an address;
 *     `internal.example.com` can point at 10.0.0.5, so the literal-IP check
 *     that most of these guards stop at proves nothing.
 *  2. Every REDIRECT HOP must satisfy (1) as well. A public URL that answers
 *     302 to `http://169.254.169.254/` walks straight through a check done only
 *     on the URL the caller typed, which is why callers here follow redirects
 *     by hand instead of handing `redirect: 'follow'` to fetch.
 *
 * This does not defend against DNS rebinding — the address is resolved here and
 * resolved again by the socket, and a name that changes answers between the two
 * wins. Closing that needs the connection pinned to the address we checked;
 * it is a smaller hole than the open door it replaces, and it is named here so
 * the next person does not have to rediscover it.
 */

const MAX_REDIRECTS = 5;

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0) return true;                       // "this network"
  if (a === 10) return true;                      // RFC 1918
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a === 192 && b === 0) return true;          // IETF protocol assignments
  if (a >= 224) return true;                      // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;   // unique local
  if (s.startsWith('fe80')) return true;                        // link-local
  if (s.startsWith('ff')) return true;                          // multicast
  // IPv4-mapped (::ffff:10.0.0.1) carries a v4 address; judge it as v4.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an address we can judge — refuse
}

export class BlockedUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`Refusing to fetch: ${reason}`);
  }
}

/** Throws unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BlockedUrlError('not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError('protocol');
  }

  // Strip the brackets IPv6 hosts carry in a URL before asking the resolver.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedUrlError('no host');

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError('private address');
    return parsed;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError('host does not resolve');
  }
  if (addresses.length === 0) throw new BlockedUrlError('host does not resolve');
  // ALL of them, not the first: a name answering with one public and one
  // private address would otherwise pass and then connect to the private one.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new BlockedUrlError('resolves to a private address');
  }
  return parsed;
}

export interface SafeFetchResult {
  response: Response;
  /** The URL actually fetched, after any redirects. */
  finalUrl: string;
}

/**
 * `fetch`, with every hop checked. Redirects are followed by hand so a 302
 * into the private network is refused rather than followed.
 */
export async function safeFetch(raw: string, init: RequestInit & { signal?: AbortSignal }): Promise<SafeFetchResult> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url.toString(), { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return { response: res, finalUrl: url.toString() };
    const location = res.headers.get('location');
    if (!location) return { response: res, finalUrl: url.toString() };
    current = new URL(location, url).toString();
  }
  throw new BlockedUrlError('too many redirects');
}
