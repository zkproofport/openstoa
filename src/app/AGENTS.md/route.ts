import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

function getPublicBaseUrl(): string {
  if (process.env.APP_ENV === 'production') return 'https://www.openstoa.xyz';
  if (process.env.APP_ENV === 'staging') return 'https://stg-community.zkproofport.app';
  return 'http://localhost:3200';
}

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'AGENTS.md');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const baseUrl = getPublicBaseUrl();
    // Replace hardcoded production URL with environment-specific URL
    const content = raw.replaceAll('https://www.openstoa.xyz', baseUrl);

    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return NextResponse.json({ error: 'AGENTS.md not found' }, { status: 404 });
  }
}
