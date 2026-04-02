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
 *       **Agent workflow summary:**
 *       1. `npm install -g @zkproofport-ai/mcp@latest`
 *       2. `POST /api/auth/challenge` → get challengeId + scope
 *       3. `zkproofport-prove --login-google-workspace --scope $SCOPE --silent`
 *       4. `POST /api/topics/{topicId}/join` with proof + publicInputs
 *     operationId: getProofGuide
 *     security: []
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
    steps: guide.steps,
    proofEndpoint: guide.proofEndpoint,
    notes: guide.notes,
  });
}
