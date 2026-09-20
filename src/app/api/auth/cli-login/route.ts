import {authorizeApiRequest} from '@/lib/apiAuthorization';
import {NextRequest,NextResponse} from 'next/server';
import {CliLoginError,startCliLogin} from '@/lib/cliLogin';
import {unhandledRouteError} from '@/lib/apiError';
/**
 * @openapi
 * /api/auth/cli-login:
 *   post:
 *     tags: [Auth]
 *     operationId: startCliLogin
 *     summary: Start an explicitly approved app proof login for CLI/MCP
 *     description: Creates a ten-minute login bound to a SHA256 code verifier. After explicit user consent, approved=true starts the mobile proof request and returns deepLink for a terminal or client-rendered QR code. Otherwise show browserUrl for browser approval. Poll with the locally retained verifier; only a verified proof creates a session. Never send tokens in redirect URLs.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [codeChallenge]
 *             properties:
 *               codeChallenge: { type: string, description: 'Base64url SHA256 of a locally generated 43–128-character code verifier' }
 *               approved: { type: boolean, default: false, description: 'Set true only after explicit user consent to start the mobile proof request immediately' }
 *               redirect_url: { type: string, description: 'Same-origin OpenStoa page to open after browser login; default /my' }
 *     responses:
 *       202:
 *         description: Login pending approval or mobile proof
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 loginId: { type: string }
 *                 browserUrl: { type: string, description: Optional browser approval URL }
 *                 deepLink: { type: string, description: App link for QR rendering; returned when explicitly approved }
 *                 expiresAt: { type: integer }
 *                 pollAfterMs: { type: integer }
 *       400: { description: Invalid challenge or redirect }
 */
export async function POST(request:NextRequest){
  const authorizationError = await authorizeApiRequest(request, '/api/auth/cli-login');
  if (authorizationError) return authorizationError;

  try{
    let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
    if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'Invalid request'},{status:400});
    const incoming = new URL(request.url);
    let origin = incoming.origin;
    // Standalone Next.js may expose 0.0.0.0 internally. Host identifies the
    // actual caller-facing endpoint; never redirect via arbitrary forwarded-host.
    const host = request.headers.get('host');
    if(host){
      if(!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/.test(host))return NextResponse.json({error:'Invalid request host'},{status:400});
      const proto=request.headers.get('x-forwarded-proto');
      const protocol=proto==='http'||proto==='https'?proto+':':incoming.protocol;
      // Parse a new authority: URL.host assignment retains an internal port
      // when the public Host omits it (Cloud Run binds to :3200).
      try { origin=new URL(`${protocol}//${host}`).origin; }
      catch { return NextResponse.json({error:'Invalid request host'},{status:400}); }
    }
    return NextResponse.json(await startCliLogin(origin,body),{status:202,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }catch(error){if(error instanceof CliLoginError)return NextResponse.json({error:error.message},{status:error.status});return unhandledRouteError('/api/auth/cli-login','POST',error);}
}
