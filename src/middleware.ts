import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { isChatPath } from '@/lib/chatPaths';

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
      /*
       * A MACHINE-READABLE VERDICT, not just a sentence.
       *
       * `error` is written for a person and gets translated, reworded and
       * shortened; nothing may branch on it. A client that receives a refusal
       * has one decision to make — keep this credential and retry, or throw it
       * away and ask the person to sign in — and until this code existed there
       * was no way to tell those apart from the response.
       *
       * That gap is what let the chat stream retry a dead token forever: the
       * server said no, correctly, every time, and the client had nothing to
       * act on. See `reconnectingStream.ts`, which now stops after two refusals.
       *
       * `no-credential` means none was sent. Distinct from a refused one: a
       * guest simply has not signed in, and telling them their session died
       * would be a lie about something that never existed.
       */
      return NextResponse.json(
        { error: 'Not authenticated', code: 'no-credential' },
        { status: 401 },
      );
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

    /*
     * CHAT IS NOT AVAILABLE TO A BROWSER SESSION.
     *
     * Read from the token's own claim, set by whichever login route minted it,
     * rather than from a header on this request — a per-request header would
     * let a browser simply say `mobile` and be believed. The claim is signed,
     * so changing it means minting a new session, which means going through a
     * login route, which is where the kind is decided.
     *
     * An `agent` session is allowed through: agents reach chat with an API key
     * whose capabilities are checked in the route (`requireAiCapability`), and
     * they hold their own keys on the machine their owner runs them on.
     *
     * A token minted before this claim existed has no `deviceKind`. It is
     * treated as `web` — the restricted answer — because the alternative is
     * that every session issued before today keeps the access this is closing.
     */
    if (isChatPath(pathname)) {
      const kind = typeof payload.deviceKind === 'string' ? payload.deviceKind : 'web';
      if (kind === 'web') {
        return NextResponse.json(
          {
            error: 'Chat is available in the ZKProofport app.',
            code: 'CHAT_MOBILE_ONLY',
          },
          { status: 403 },
        );
      }
    }

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
      /*
       * `credential-dead` — the token was READ and REFUSED: expired, or signed
       * with a key this server does not accept. Re-sending it will never work,
       * so a client that keeps it is knocking on a door that will not open.
       *
       * The cookie is cleared for browsers. A mobile client holds a Bearer
       * token the server cannot reach, so this code is the only way to tell it
       * to drop what it has.
       */
      return clearCookie(
        NextResponse.json({ error: 'Invalid session', code: 'credential-dead' }, { status: 401 }),
      );
    }
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return clearCookie(NextResponse.redirect(loginUrl));
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon\\.png).*)'],
};
