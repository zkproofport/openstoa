import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/logout';

export async function POST() {
  logger.info(ROUTE, 'POST request received, clearing session cookie');
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  logger.info(ROUTE, 'Logout complete, sending 200');
  return response;
}
