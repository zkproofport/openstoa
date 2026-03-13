import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPPORT_EMAIL = 'support@zkproofport.app';
const FROM_EMAIL = 'OpenStoa <noreply@zkproofport.app>';

/**
 * @openapi
 * /api/beta-signup:
 *   post:
 *     tags: [Auth]
 *     summary: Request beta invite
 *     description: Submit email and platform preference to request a closed beta invite for the ZKProofport mobile app.
 *     operationId: betaSignup
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               organization:
 *                 type: string
 *               platform:
 *                 type: string
 *                 enum: [iOS, Android, Both]
 *     responses:
 *       200:
 *         description: Beta invite request submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 */
export async function POST(req: NextRequest) {
  if (!RESEND_API_KEY) {
    return NextResponse.json({ error: 'RESEND_API_KEY environment variable is required' }, { status: 500 });
  }

  let body: { email?: string; organization?: string; platform?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, organization, platform } = body;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
  }

  const trimmedEmail = email.trim();
  const trimmedOrg = organization?.trim() || '';
  const resolvedPlatform = platform || 'Both';

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="padding:32px 40px 24px 40px;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:22px;font-weight:600;color:#111827;margin:0 0 4px 0;">Beta Invite Request</div>
      <div style="font-size:13px;color:#6b7280;">OpenStoa (ZK Community)</div>
    </div>
    <div style="padding:24px 40px;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">From</div>
      <div style="font-size:15px;color:#111827;">${trimmedOrg ? `${trimmedOrg} &lt;${trimmedEmail}&gt;` : trimmedEmail}</div>
    </div>
    <div style="padding:32px 40px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:15px;line-height:1.6;color:#111827;white-space:pre-wrap;">${trimmedEmail}${trimmedOrg ? ` (${trimmedOrg})` : ''} has requested a beta invite for the ZKProofport app through the OpenStoa community page.

- Organization: ${trimmedOrg || 'N/A'}
- Platform: ${resolvedPlatform}
- Source: OpenStoa community login page

Please register this email as a tester on the corresponding platform (App Store Connect / Google Play Console) and send an invite.</div>
    </div>
    <div style="padding:24px 40px;background:#f9fafb;">
      <div style="font-size:12px;color:#9ca3af;">${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}</div>
    </div>
  </div>
`;

  const resend = new Resend(RESEND_API_KEY);

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: SUPPORT_EMAIL,
      replyTo: trimmedEmail,
      subject: `[Beta Invite] ${trimmedEmail} — ${resolvedPlatform}`,
      html: htmlBody,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send email';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
