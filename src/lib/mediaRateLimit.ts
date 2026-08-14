/**
 * Rate limiting for `GET /api/media/{key}` (M-7) — the ONLY read path for
 * post/topic/profile images once the R2 bucket goes private, and today the
 * one route that STREAMS real bytes through the app with no rate limit at
 * all. Unlike every `checkRateLimit` caller in `src/lib/mls/http.ts` (13
 * call sites, all authenticated), this route is reachable WITHOUT a session
 * by design — public-topic images and avatars are guest-readable — so
 * there is often no `userId` to key on. See `resolveMediaIdentity` for how
 * that split is decided, and `checkMediaReadRateLimit` for why this limiter
 * fails OPEN where the MLS ones fail closed.
 */
import { NextRequest } from 'next/server';
import { incrementRateWindow } from '@/lib/redisRateLimit';
import { logger } from '@/lib/logger';

const MODULE = 'lib/mediaRateLimit';

/**
 * Abuse ceiling, not traffic shaping — Google's own crawl-rate guidance
 * (developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate)
 * warns that a significant share of 429/500/503 responses measurably
 * reduces crawl rate, and that the same status served across multiple days
 * can drop a URL from the index; they do not recommend throttling beyond
 * 1-2 days. Standing 429s on images would undo the per-post/per-topic OG
 * metadata work (`src/lib/pageMetadata.ts`) that exists specifically to
 * give crawlers a real card. So the number below is sized to sit
 * comfortably ABOVE any real page view, not to shape traffic down to some
 * "fair" per-visitor rate.
 *
 * Sized from actual page cost, not guessed:
 *  - `MediaGallery`'s feed mode (`src/components/post/MediaGallery.tsx`)
 *    renders exactly ONE `<img>` per post — the first image, or the first
 *    video's thumbnail — never the whole set. Detail mode's swipeable
 *    carousel mounts only the CURRENT slide, not all of a post's up-to-10
 *    images at once. Neither view front-loads more than one image request
 *    per post.
 *  - Each post row also renders one author `Avatar`. A topic page's
 *    infinite-scroll `PAGE_SIZE = 20` (`TopicPageClient.tsx`) load therefore
 *    costs AT MOST `20 posts × (1 media + 1 avatar) + 1 topic-header avatar`
 *    = 41 image requests.
 *  - An aggressively-scrolling real visitor firing ~5 such loads inside one
 *    minute (fast infinite-scroll through 100 posts) costs ≈205 requests.
 *
 * 300/60s leaves ~45% headroom above that plausible peak while still
 * capping any single identity at 5 req/s sustained — trivial for a human to
 * stay under, and a ceiling an abuse script blows past in well under a
 * second, which is the distinction between an abuse ceiling and traffic
 * shaping.
 *
 * A crawler generating a link-preview card fetches ONE `og:image` per page
 * crawled — crawlers do not execute client JS, so they never trigger the
 * feed's `fetch()`-driven image loads that make up the 41-per-page number
 * above. Even an aggressive crawl of 100+ pages/minute from one IP stays
 * inside this ceiling without any user-agent allowlist, which is
 * deliberate: a UA string is trivially spoofed by the exact abuse this
 * limiter exists to bound, so exempting "crawlers" by UA would just be a
 * bypass with a name on it. Generosity, not detection, is what protects
 * real crawlers here.
 */
export const MEDIA_READ_RATE = { max: 300, windowSec: 60 };

const REDIS_KEY_PREFIX = 'community:ratelimit:media:';

/** Loose IPv4/IPv6 shape — not a full validator, just enough to refuse
 *  obvious garbage before it becomes a Redis key (see `resolveMediaIdentity`). */
const IP_SHAPED_RE = /^[0-9a-fA-F:.]{2,64}$/;

const UNKNOWN_IDENTITY = 'unknown';

/**
 * The LAST comma-separated entry of `X-Forwarded-For`, or `UNKNOWN_IDENTITY`
 * if that entry doesn't look IP-shaped or the header is absent.
 *
 * WHY THE LAST ENTRY, VERIFIED FOR THIS DEPLOYMENT (not assumed):
 *  - Cloudflare is DNS-only ("gray cloud") for `openstoa.xyz` —
 *    `docs/migration/cloudflare-setup.md`: "전부 DNS-only (gray cloud) —
 *    Google Sites/Workspace 호환 위해". It never proxies this traffic, so
 *    `CF-Connecting-IP` is NEVER legitimately set here — trusting it would
 *    trust a header nothing validates, which is worse than not checking an
 *    IP at all because it LOOKS authoritative and isn't.
 *  - Cloud Run is deployed `--allow-unauthenticated` with no `--ingress`
 *    restriction (`.github/workflows/deploy.yml`), i.e. the default ingress
 *    (`all`) — directly reachable from the public internet, no mandatory
 *    external HTTPS Load Balancer in front. So the only hop guaranteed to
 *    sit between every request and this container is Cloud Run's own
 *    serving infrastructure.
 *  - That infrastructure APPENDS the real observed peer IP as the LAST
 *    `X-Forwarded-For` entry rather than trusting/replacing what the client
 *    sent (standard reverse-proxy chain semantics — confirmed for Cloud Run
 *    specifically via multiple independent write-ups during this change;
 *    see the task report for links, since no single official Cloud-Run-
 *    specific page states it in these exact adversarial terms). Any entry
 *    BEFORE the last one is whatever the client itself chose to send and is
 *    trivially forged — including by an attacker prepending a large batch
 *    of fake IPs specifically to try to make each request land in a fresh
 *    Redis bucket. Because Cloud Run always appends its own real
 *    observation last, that specific bypass does not work: the attacker
 *    can only control entries this function ignores.
 *  - Next.js 15 removed `NextRequest.ip`/`.geo` entirely (platform-specific,
 *    gone as of the App Router v15 upgrade guide) — for a self-hosted
 *    deployment its own migration guide says to read `x-forwarded-for`
 *    manually, which is what this does.
 *
 * Local dev (bare `docker compose`, no Cloud Run frontend) never has this
 * header set by anything trustworthy, so every such caller collapses onto
 * `UNKNOWN_IDENTITY` and shares one bucket — a local-dev convenience, not a
 * production security boundary, since production's Cloud Run frontend
 * cannot be bypassed and always sets this header.
 */
export function anonymousMediaIdentity(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return UNKNOWN_IDENTITY;
  const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || !IP_SHAPED_RE.test(last)) return UNKNOWN_IDENTITY;
  return last;
}

/**
 * The rate-limit identity for one request: the session's `userId` when one
 * exists, else the resolved anonymous IP identity. A signed-in caller is
 * ALWAYS keyed on `userId`, never on IP — two logged-in users behind the
 * same NAT/office network must not share a budget, and a mobile user
 * switching towers mid-session must not get a fresh one every time their
 * carrier reassigns an address. Both limiters share one ceiling
 * (`MEDIA_READ_RATE`) rather than giving sessions a bigger budget: this is
 * an abuse ceiling per identity, not a loyalty perk.
 */
export function resolveMediaIdentity(request: NextRequest, sessionUserId: string | null): string {
  return sessionUserId ?? anonymousMediaIdentity(request);
}

/**
 * Check + increment the media-read budget for `identity`. Returns `true`
 * when the request is within budget.
 *
 * FAILS OPEN on a Redis error — the deliberate OPPOSITE of every
 * `checkRateLimit` caller in `src/lib/mls/http.ts`, which fail closed by
 * letting the exception propagate up to `unhandledRouteError` (500). Those
 * all gate WRITES behind an authenticated session; failing closed there
 * trades a temporary write outage for abuse protection on already-scarce
 * backend state — a defensible trade for a mutation.
 *
 * `GET /api/media` is the opposite shape: read-only, unauthenticated for
 * public content BY DESIGN, and newly Redis-dependent only because of this
 * change (before M-7 it never touched Redis at all). Failing closed here
 * would mean a Redis blip takes down every image on the site — including
 * for the crawlers the per-post/per-topic OG metadata work just started
 * serving real cards to, and for every logged-in user's feed. This is an
 * abuse ceiling on a public read path, not an auth boundary (the exact
 * asymmetry the task brief called out), so a Redis outage degrades to
 * "temporarily unlimited," not "temporarily broken."
 */
export async function checkMediaReadRateLimit(identity: string): Promise<boolean> {
  try {
    const n = await incrementRateWindow(`${REDIS_KEY_PREFIX}${identity}`, MEDIA_READ_RATE.windowSec);
    return n <= MEDIA_READ_RATE.max;
  } catch (error) {
    logger.warn(MODULE, 'Redis unavailable for media rate limit — failing open (read-only, unauthenticated-capable path)', {
      identity,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
