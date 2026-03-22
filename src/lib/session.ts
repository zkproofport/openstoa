import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'zk-community-session';

function getSecret(): Uint8Array {
  const jwt = process.env.COMMUNITY_JWT_SECRET;
  if (!jwt) throw new Error('COMMUNITY_JWT_SECRET environment variable is required');
  return new TextEncoder().encode(jwt);
}

export interface SessionPayload extends JWTPayload {
  userId: string;
  nickname: string;
  verifiedAt: number;
  role?: string;
}

export async function createSession(userId: string, nickname: string): Promise<string> {
  const token = await new SignJWT({
    userId,
    nickname,
    verifiedAt: Date.now(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret());

  return token;
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export async function getSessionFromCookies(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function getSession(request: NextRequest): Promise<SessionPayload | null> {
  // 1. Try cookie
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieToken) return verifySession(cookieToken);

  // 2. Try Bearer token
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (bearerToken) return verifySession(bearerToken);

  return null;
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 24 hours
    path: '/',
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
}
