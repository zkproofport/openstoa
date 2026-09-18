import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('public landing metadata assets', () => {
  it.each(['/icon.svg', '/openstoa-icon-180.png'])('serves %s without a login redirect', async (pathname) => {
    const response = await middleware(new NextRequest(`http://localhost${pathname}`));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
