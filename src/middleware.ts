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
  '/api/health',
  '/api/docs/openapi.json',
  '/api/beta-signup',
  '/docs',
  '/icon.png',
  '/skill.md',
];

const PUBLIC_PREFIXES = [
  '/_next',
  '/favicon.ico',
  '/api/auth/poll/',
  '/docs',
];

// Paths accessible without authentication (guests can browse).
// If a token IS present it will still be validated; only the
// "no token" case is allowed through.
const GUEST_ACCESSIBLE_PREFIXES = [
  '/topics',       // topic list page + topic/post detail pages
  '/api/topics',   // GET /api/topics, GET /api/topics/[topicId], GET /api/topics/[topicId]/posts
  '/api/posts/',   // GET /api/posts/[postId]
  '/api/tags',     // tag search/list
  '/api/categories', // GET /api/categories
  '/api/feed',     // GET /api/feed (cross-topic feed)
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
    if (!guestAccessible && (pathname.startsWith('/topics') || pathname.startsWith('/api/topics') || pathname.startsWith('/api/posts') || pathname.startsWith('/api/tags') || pathname.startsWith('/api/bookmarks') || pathname.startsWith('/api/upload'))) {
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
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon\\.png).*)'],
};
