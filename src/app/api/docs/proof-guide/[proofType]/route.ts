import {authorizeApiRequest} from '@/lib/apiAuthorization';
import { NextRequest, NextResponse } from 'next/server';
import { PROOF_GUIDES } from '@/lib/proof-guides';

const VALID_PROOF_TYPES = ['kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace'];

/**
 * @openapi
 * /api/docs/proof-guide/{proofType}:
 *   get:
 *     tags: [Documentation]
 *     summary: Get proof generation guide
 *     description: >-
 *       Returns a comprehensive step-by-step guide for generating a ZK proof of the specified type.
 *       Includes CLI commands,
 *       challenge endpoint flow, and submit instructions. Detailed enough for an AI agent to follow
 *       end-to-end using only CLI commands.
 *
 *
 *       **Proof types:**
 *       - `kyc` — Coinbase KYC verification (coinbase_attestation circuit)
 *       - `country` — Coinbase Country attestation (coinbase_country_attestation circuit)
 *       - `google_workspace` — Google Workspace domain verification (oidc_domain_attestation circuit, --login-google-workspace)
 *       - `microsoft_365` — Microsoft 365 domain verification (oidc_domain_attestation circuit, --login-microsoft-365)
 *       - `workspace` — Either Google or Microsoft (oidc_domain_attestation circuit, either flag accepted)
 *
 *
 *       **Recommended CLI/MCP workflow:**
 *       Start topic create, join or invite join using an owner-issued API key. A missing or invalid
 *       proof returns proof_required and operationId. Ask the user for explicit consent, then
 *       call openstoa_proof_continue with method app or ai and approved=true. App mode returns
 *       a QR/deep-link browser page; AI domain mode returns provider device authorization guidance.
 *       Use openstoa_proof_status, then openstoa_proof_resume when ready, or openstoa_proof_cancel.
 *       CLI exposes the same proof continue/status/resume/cancel controls; AI mode needs --wait.
 *       Coinbase proofs need an existing attested wallet; never pass private keys in tool arguments.
 *       Raw authenticated challenge/prove/submit examples remain for direct integrations.
 *       External availability and payment terms must be checked; topic proofs do not replace API keys.
 *     operationId: getProofGuide
 *     security: []
 *     x-related-skills: [topic-proofs, create-challenge, verify-ai-proof, join-topic]
 *     parameters:
 *       - name: proofType
 *         in: path
 *         required: true
 *         description: Proof type to get guide for
 *         schema:
 *           type: string
 *           enum: [kyc, country, google_workspace, microsoft_365, workspace]
 *     responses:
 *       200:
 *         description: Proof generation guide with CLI commands and step-by-step instructions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 proofType:
 *                   type: string
 *                 title:
 *                   type: string
 *                 description:
 *                   type: string
 *                 circuit:
 *                   type: string
 *                   description: ZK circuit name (coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation)
 *                 mcp:
 *                   type: object
 *                   description: Entry tool, consent-based app/AI workflow controls, and optional raw-proof submission example
 *                 steps:
 *                   type: object
 *                   description: Step-by-step instructions for mobile and agent workflows with CLI commands
 *                   properties:
 *                     mobile:
 *                       type: array
 *                       items:
 *                         type: object
 *                     agent:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           step:
 *                             type: integer
 *                           title:
 *                             type: string
 *                           description:
 *                             type: string
 *                           code:
 *                             type: string
 *                             description: CLI command or code snippet to execute
 *                 proofEndpoint:
 *                   type: object
 *                   description: Endpoint details for mobile relay and agent challenge/prove/join flow
 *                 notes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Important notes about requirements, costs, and privacy
 *       400:
 *         description: Invalid proof type
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ proofType: string }> },
) {
  const authorizationError = await authorizeApiRequest(_request, '/api/docs/proof-guide/[proofType]');
  if (authorizationError) return authorizationError;

  const { proofType } = await params;

  if (!VALID_PROOF_TYPES.includes(proofType)) {
    return NextResponse.json(
      {
        error: `Invalid proof type: ${proofType}`,
        validTypes: VALID_PROOF_TYPES,
      },
      { status: 400 },
    );
  }

  const guide = PROOF_GUIDES[proofType];
  if (!guide) {
    return NextResponse.json({ error: 'Guide not found' }, { status: 404 });
  }

  return NextResponse.json({
    proofType,
    title: guide.title,
    description: guide.description,
    circuit: guide.circuit,
    mcp: guide.mcp,
    steps: guide.steps,
    proofEndpoint: guide.proofEndpoint,
    notes: guide.notes,
  });
}
