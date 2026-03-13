import { NextResponse } from 'next/server';
import spec from '@/generated/openapi-spec.json';

export async function GET() {
  return NextResponse.json(spec);
}
