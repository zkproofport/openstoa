import {authorizeApiRequest} from '@/lib/apiAuthorization';
import {NextRequest} from 'next/server';
import { NextResponse } from 'next/server';
import spec from '@/generated/openapi-spec.json';

export async function GET(request: NextRequest) {
  const authorizationError = await authorizeApiRequest(request, '/api/docs/openapi.json');
  if (authorizationError) return authorizationError;

  return NextResponse.json(spec);
}
