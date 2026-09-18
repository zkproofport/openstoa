import {authorizeApiRequest} from '@/lib/apiAuthorization';
import {NextRequest,NextResponse} from 'next/server';
import {CliLoginError,readCliLogin} from '@/lib/cliLogin';
import {setSessionCookie} from '@/lib/session';
import {unhandledRouteError} from '@/lib/apiError';
/**
 * @openapi
 * /api/auth/cli-login/{loginId}:
 *   post:
 *     tags: [Auth]
 *     operationId: completeCliLogin
 *     summary: Poll or cancel a bound login and receive the verified session
 *     description: Supply exactly one credential. CLI/MCP sends its local codeVerifier and receives token only on completion. Browser sends the fragment approvalToken after explicit approval; completion sets an HttpOnly session cookie and returns a safe redirectUrl, never a JSON token. Repeated completion returns the same session within the request lifetime.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: loginId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               codeVerifier: { type: string }
 *               approvalToken: { type: string }
 *               cancel: { type: boolean }
 *     responses:
 *       200: { description: "Completed or cancelled; browser receives cookie and redirectUrl, CLI receives token and identity" }
 *       202: { description: Awaiting approval or proof; pollAfterMs and browser-only deepLink }
 *       400: { description: Invalid or rejected Google login proof }
 *       403: { description: Invalid login credential }
 *       410: { description: Login request expired }
 */
export async function POST(request:NextRequest,{params}:{params:Promise<{loginId:string}>}){
  const authorizationError = await authorizeApiRequest(request, '/api/auth/cli-login/[loginId]');
  if (authorizationError) return authorizationError;

  try{
    let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
    if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'Invalid request'},{status:400});
    const {browserToken,...result}=await readCliLogin((await params).loginId,body);
    const response=NextResponse.json(result,{status:result.status==='pending'?202:200,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    if(browserToken)setSessionCookie(response,browserToken);
    return response;
  }catch(error){if(error instanceof CliLoginError)return NextResponse.json({error:error.message},{status:error.status});return unhandledRouteError('/api/auth/cli-login/[loginId]','POST',error);}
}
