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

    // /topics/* requires session WITH nickname (not a temp anon_ nickname)
    // Skip nickname check for guest-accessible paths (they work without auth,
    // so they should also work with a valid token that has no nickname yet)
    if (!guestAccessible && (pathname.startsWith('/topics') || pathname === '/dm' || pathname.startsWith('/dm/') || pathname.startsWith('/api/topics') || pathname.startsWith('/api/dm') || pathname.startsWith('/api/posts') || pathname.startsWith('/api/comments') || pathname.startsWith('/api/tags') || pathname.startsWith('/api/bookmarks') || pathname.startsWith('/api/upload'))) {
      const nickname = payload.nickname as string;
      if (!nickname || nickname.startsWith('anon_')) {
        if (isApiRoute(pathname)) {
          return NextResponse.json(
            { error: 'Nickname required. Set your nickname at /profile first.' },
            { status: 403 },
          );
        }
        const profileUrl = new URL('/profile', request.url);
        profileUrl.searchParams.set('returnTo', pathname);
        return NextResponse.redirect(profileUrl);
      }
    }

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
