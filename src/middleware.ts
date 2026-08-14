import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PATHS = [
  '/',
  '/api/auth/proof-request',
  '/api/auth/challenge',
  '/api/auth/verify/ai',
  '/api/auth/poll',
  '/api/auth/logout',
  '/api/auth/token-login',
  '/api/auth/session',
  '/api/auth/dev-login',
  '/api/health',
  '/api/docs/openapi.json',
  '/api/beta-signup',
  '/api/ask',
  '/api/ask/stream',
  // OG link previews + image proxy are pure server-side reads of public
  // web content. No reason to gate them behind auth (and the image proxy
  // gets used as a plain <Image src=...> URL by the mobile client, which
  // wouldn't carry the Bearer token).
  '/api/og',
  '/api/og/image',
  '/ask',
  '/docs',
  '/icon.png',
  '/SKILL.md',
  '/AGENTS.md',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
];

const PUBLIC_PREFIXES = [
  '/_next',
  '/favicon.ico',
  '/images/',
  '/api/auth/poll/',
  '/api/docs/',
  '/docs',
  '/.well-known/',
  // Auto-generated skills tree (/skills/getting-started/*, /skills/api/*, etc.)
  '/skills/',
];

// Paths accessible without authentication (guests can browse).
// If a token IS present it will still be validated; only the
// "no token" case is allowed through.
const GUEST_ACCESSIBLE_PREFIXES = [
  '/topics',       // topic list page + topic/post detail pages
  '/recorded',     // on-chain recorded posts page
  '/api/topics',   // GET /api/topics, GET /api/topics/[topicId], GET /api/topics/[topicId]/posts
  '/api/posts/',   // GET /api/posts/[postId]
  '/api/tags',     // tag search/list
  '/api/categories', // GET /api/categories
  '/api/feed',     // GET /api/feed (cross-topic feed)
  '/api/stats',    // GET /api/stats (community stats)
  '/api/media/',   // GET /api/media/[...key] (M-5) — the route itself decides
                   // guest/member/owner per object; middleware must not 401
                   // a guest before the route gets a chance to allow public
                   // topic images and avatars through.
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isGuestAccessiblePath(pathname: string): boolean {
  return GUEST_ACCESSIBLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

// Bearer tokens shaped like `osk_<hex>` are API keys (src/lib/apiKeys.ts), not
// JWTs — `jwtVerify` below would always throw for them. This constant is
// duplicated (not imported) from `src/lib/apiKeys.ts` on purpose: middleware
// runs on the Edge runtime and cannot pull in that module's `@/lib/db` import
// chain (Node-only `pg` driver). Keep the two literals in sync if this changes.
const API_KEY_PREFIX = 'osk_';

function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Normalize public .md paths to their canonical case so a link shared
  // with mixed casing serves the same static file:
  //   - `/skill.md` and the `/skill/...` tree are emitted in all-lowercase
  //     by `scripts/generate-skill.ts`, so any case variant lowercases.
  //   - `/AGENTS.md` is the one capitalized file we serve; map `/agents.md`
  //     and other cases onto it explicitly.
  if (pathname.toLowerCase().endsWith('.md')) {
    const lower = pathname.toLowerCase();
    let canonical: string | null = null;
    if (lower === '/agents.md') canonical = '/AGENTS.md';
    else if (lower === '/skill.md') canonical = '/SKILL.md';
    else if (lower.startsWith('/skills/')) {
      // Directories under /skills/ are lowercase on disk; the leaf
      // filename is uppercase SKILL.md. Build the canonical path from
      // the lowered request path and re-uppercase a `/skill.md` suffix.
      canonical = lower.endsWith('/skill.md')
        ? lower.slice(0, -'/skill.md'.length) + '/SKILL.md'
        : lower;
    }
    if (canonical && canonical !== pathname) {
      const url = request.nextUrl.clone();
      url.pathname = canonical;
      return NextResponse.rewrite(url);
    }
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookieToken = request.cookies.get('zk-community-session')?.value;
  const authHeader = request.headers.get('authorization');
  const bearerToken =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = cookieToken ?? bearerToken;

  const guestAccessible = isGuestAccessiblePath(pathname);

  if (!token) {
    // Guest-accessible paths are allowed through without auth
    if (guestAccessible) {
      return NextResponse.next();
    }
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // API-key Bearer tokens can't be JWT-verified here (Edge runtime has no DB
  // access to hash-lookup the key). Defer to the route handler's getSession()
  // (Node runtime, real DB validation) — every route already 401s on a null
  // session, so an invalid/unknown/revoked key is still rejected, just one
  // layer later. This also means the nickname-required gate below is skipped
  // for API-key requests; that's an accepted trade-off (nickname is a UX
  // guard, not a security boundary, and a key can only be minted from an
  // already-authenticated profile session).
  if (!cookieToken && bearerToken && isApiKeyToken(bearerToken)) {
    return NextResponse.next();
  }

  const COMMUNITY_JWT_SECRET = process.env.COMMUNITY_JWT_SECRET;
  if (!COMMUNITY_JWT_SECRET) {
    throw new Error('COMMUNITY_JWT_SECRET environment variable is required');
  }

  const secret = new TextEncoder().encode(COMMUNITY_JWT_SECRET);

  try {
    const { payload } = await jwtVerify(token, secret);

    // /profile is accessible with session but no nickname required
    if (pathname === '/profile' || pathname.startsWith('/api/profile/')) {
      return NextResponse.next();
    }

    /*
     * NO nickname gate.
     *
     * Every account is given a real, readable name the moment it is created
     * (`defaultNickname`), so there is nothing to wait for. This used to redirect
     * to /profile and answer 403 on /api/topics, /api/dm, /api/posts and the
     * rest until the user picked a different one — which meant a brand-new
     * account could sign in, open chat, and watch a spinner that would never
     * resolve, because the request behind it was being refused. An anonymous
     * community has no reason to hold writes behind a display name.
     */

    return NextResponse.next();
  } catch {
    // Invalid/expired token — clear the stale cookie
    const clearCookie = (res: NextResponse) => {
      res.cookies.set('zk-community-session', '', { maxAge: 0, path: '/' });
      return res;
    };

    // Guest-accessible paths: allow through as guest (clear stale cookie)
    if (guestAccessible) {
      return clearCookie(NextResponse.next());
    }
    if (isApiRoute(pathname)) {
      return clearCookie(NextResponse.json({ error: 'Invalid session' }, { status: 401 }));
    }
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return clearCookie(NextResponse.redirect(loginUrl));
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon\\.png).*)'],
};
