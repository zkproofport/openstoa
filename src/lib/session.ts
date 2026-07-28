import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isApiKeyToken, verifyApiKey, touchApiKeyLastUsed } from '@/lib/apiKeys';

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
  isAI?: boolean;
  /**
   * Present ONLY for an API-key-authenticated request (design §7 follow-up).
   * The capability set is bound to the key itself — `requireAiCapability`
   * checks THIS array directly instead of a fresh ai_permissions lookup, since
   * the key IS the scoped credential.
   */
  apiKeyId?: string;
  apiKeyCmd?: string[];
  apiKeyHistoryGrant?: string;
}

export async function createSession(userId: string, nickname: string, options?: { isAI?: boolean }): Promise<string> {
  const token = await new SignJWT({
    userId,
    nickname,
    verifiedAt: Date.now(),
    ...(options?.isAI && { isAI: true }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
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
  if (!bearerToken) return null;

  // 2a. API key (`osk_...`) — resolve via DB; capabilities come FROM THE KEY,
  // not a fresh ai_permissions lookup (the key IS the scoped credential).
  if (isApiKeyToken(bearerToken)) {
    return getApiKeySession(bearerToken);
  }

  // 2b. JWT (cookie-equivalent Bearer, e.g. dev-login / verify/ai tokens).
  return verifySession(bearerToken);
}

/** Resolve an API-key Bearer token to a SessionPayload, or null if invalid/revoked. */
async function getApiKeySession(rawKey: string): Promise<SessionPayload | null> {
  const keyRow = await verifyApiKey(db, rawKey);
  if (!keyRow) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, keyRow.userId) });
  if (!user) return null;

  // Best-effort — must never block or fail the auth path on a write hiccup.
  void touchApiKeyLastUsed(db, keyRow.id).catch(() => {});

  return {
    userId: keyRow.userId,
    nickname: user.nickname,
    verifiedAt: Date.now(),
    isAI: keyRow.isAI,
    apiKeyId: keyRow.id,
    apiKeyCmd: keyRow.cmd,
    apiKeyHistoryGrant: keyRow.historyGrant,
  };
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
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
