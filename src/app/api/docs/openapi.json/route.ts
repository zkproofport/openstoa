import { NextResponse } from 'next/server';
import { spec } from '@/lib/swagger';

export async function GET() {
  return NextResponse.json(spec);
}
