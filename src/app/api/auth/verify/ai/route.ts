import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { consumeChallenge } from '@/lib/challenge';
import { normalizePublicInputs, COMMUNITY_SCOPE } from '@/lib/proof';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
} from '@zkproofport-app/sdk';
import { createSession, setSessionCookie } from '@/lib/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { verifyProof } from '@zkproofport-ai/sdk';

const ROUTE = '/api/auth/verify/ai';

/**
 * @openapi
 * /api/auth/verify/ai:
 *   post:
 *     tags: [Auth]
 *     summary: Verify AI agent proof and get session token
 *     description: >-
 *       Verifies an AI agent's ZK proof against a previously issued challenge. On success,
 *       creates/retrieves the user account and returns both a session cookie and a Bearer token.
 *       The Bearer token can be used for subsequent API calls via the Authorization header.
 *     operationId: verifyAiProof
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [challengeId, result]
 *             properties:
 *               challengeId:
 *                 type: string
 *                 description: Challenge ID from /api/auth/challenge
 *               result:
 *                 type: object
 *                 description: Proof result from the ZK proof generation
 *                 required: [proof, publicInputs, verification]
 *                 properties:
 *                   proof:
 *                     type: string
 *                     description: 0x-prefixed proof hex string
 *                   publicInputs:
 *                     type: string
 *                     description: 0x-prefixed public inputs hex string
 *                   verification:
 *                     type: object
 *                     description: On-chain verification parameters
 *                     required: [chainId, verifierAddress, rpcUrl]
 *                     properties:
 *                       chainId:
 *                         type: number
 *                         example: 8453
 *                         description: Chain ID where the verifier contract is deployed
 *                       verifierAddress:
 *                         type: string
 *                         example: "0xf7ded73e7a7fc8fb030c35c5a88d40abe6865382"
 *                         description: Address of the on-chain verifier contract
 *                       rpcUrl:
 *                         type: string
 *                         example: "https://mainnet.base.org"
 *                         description: RPC URL for the target chain
 *                   proofWithInputs:
 *                     type: string
 *                     description: Combined proof + public inputs hex (optional)
 *                   attestation:
 *                     type: object
 *                     nullable: true
 *                     description: Raw attestation data (optional)
 *                   timing:
 *                     type: object
 *                     description: Proof generation timing metadata (optional)
 *     responses:
 *       200:
 *         description: Verification successful. Sets session cookie and returns Bearer token.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   description: Authenticated user ID
 *                 needsNickname:
 *                   type: boolean
 *                   description: Whether the user still needs to set a nickname
 *                 token:
 *                   type: string
 *                   description: Bearer token for subsequent API calls
 *       400:
 *         description: Invalid challenge, expired, scope mismatch, or on-chain verification failure
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const body = await request.json();
    const { challengeId, result, paymentTxHash, teeAttestation } = body;

    if (!challengeId || !result) {
      logger.warn(ROUTE, 'Missing required fields', { hasChallengeId: !!challengeId, hasResult: !!result });
      return NextResponse.json(
        { error: 'Missing required fields: challengeId, result' },
        { status: 400 },
      );
    }

    if (!result.proof || !result.publicInputs || !result.verification) {
      logger.warn(ROUTE, 'Incomplete result', {
        hasProof: !!result.proof,
        hasPublicInputs: !!result.publicInputs,
        hasVerification: !!result.verification,
      });
      return NextResponse.json(
        { error: 'Incomplete result: proof, publicInputs, and verification are required' },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Consuming challenge', { challengeId });

    const challengeValid = await consumeChallenge(challengeId);
    if (!challengeValid) {
      logger.warn(ROUTE, 'Invalid or expired challenge', { challengeId });
      return NextResponse.json(
        { error: 'Invalid or expired challenge' },
        { status: 401 },
      );
    }

    logger.info(ROUTE, 'Challenge consumed, verifying proof on-chain via AI SDK', { challengeId });

    // Production-only security checks: reject staging AI proofs
    if (process.env.APP_ENV === 'production') {
      // Check 1: Payment TX must exist on Base mainnet (chain 8453)
      if (!paymentTxHash) {
        logger.warn(ROUTE, 'Production: paymentTxHash is required', { challengeId });
        return NextResponse.json(
          { error: 'paymentTxHash is required in production' },
          { status: 400 },
        );
      }

      const mainnetProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');
      const tx = await mainnetProvider.getTransaction(paymentTxHash);
      if (!tx) {
        logger.warn(ROUTE, 'Production: paymentTxHash not found on Base mainnet', { challengeId, paymentTxHash });
        return NextResponse.json(
          { error: 'Payment transaction not found on Base mainnet' },
          { status: 400 },
        );
      }

      logger.info(ROUTE, 'Production: payment TX verified on Base mainnet', { challengeId, paymentTxHash });

      // Check 2: PCR0 non-zero (TEE attestation, if provided)
      if (teeAttestation) {
        const attestationBytes = Buffer.from(teeAttestation, 'base64');

        // Find 'pcrs' marker in the CBOR-encoded attestation document
        const pcrsMarker = Buffer.from('pcrs', 'utf8');
        const markerIdx = attestationBytes.indexOf(pcrsMarker);

        if (markerIdx === -1) {
          logger.warn(ROUTE, 'Production: pcrs marker not found in teeAttestation', { challengeId });
          return NextResponse.json(
            { error: 'Invalid teeAttestation: pcrs marker not found' },
            { status: 400 },
          );
        }

        // PCR0 is a 48-byte value. In CBOR, the map key 0 follows 'pcrs', then a
        // CBOR bstr header precedes the 48 bytes. Scan forward for the 48-byte bstr
        // (CBOR major type 2, additional info 24 or 25 with length 48 = 0x30).
        // We look for 0x58 0x30 (bstr, 1-byte length=48) after the 'pcrs' marker.
        const searchStart = markerIdx + pcrsMarker.length;
        let pcr0: Buffer | null = null;

        for (let i = searchStart; i < attestationBytes.length - 49; i++) {
          // CBOR bstr with 1-byte uint8 length: 0x58 0x30 = 48 bytes
          if (attestationBytes[i] === 0x58 && attestationBytes[i + 1] === 0x30) {
            pcr0 = attestationBytes.slice(i + 2, i + 2 + 48);
            break;
          }
        }

        if (!pcr0) {
          logger.warn(ROUTE, 'Production: PCR0 not found in teeAttestation', { challengeId });
          return NextResponse.json(
            { error: 'Invalid teeAttestation: PCR0 not found' },
            { status: 400 },
          );
        }

        const isAllZeros = pcr0.every((b) => b === 0);
        if (isAllZeros) {
          logger.warn(ROUTE, 'Production: PCR0 is all zeros (debug mode TEE), rejecting', { challengeId });
          return NextResponse.json(
            { error: 'TEE attestation is in debug mode (PCR0 all zeros)' },
            { status: 400 },
          );
        }

        logger.info(ROUTE, 'Production: PCR0 non-zero, TEE attestation valid', { challengeId });
      }
    }

    // Verify proof on-chain using @zkproofport-ai/sdk
    const verification = await verifyProof(result);
    if (!verification.valid) {
      logger.warn(ROUTE, 'Proof verification failed', { challengeId, error: verification.error });
      return NextResponse.json(
        { error: 'Proof verification failed', details: verification.error },
        { status: 400 },
      );
    }

    logger.info(ROUTE, 'Proof verified on-chain', { challengeId });

    // Normalize publicInputs for scope/nullifier extraction
    const normalizedInputs = normalizePublicInputs(result.publicInputs);

    // Determine circuit from normalized array length
    // coinbase_attestation: 128 fields, coinbase_country_attestation: 150 fields
    const circuit = normalizedInputs.length > 128
      ? 'coinbase_country_attestation'
      : 'coinbase_attestation';

    // Verify scope
    const scope = extractScopeFromPublicInputs(normalizedInputs, circuit);
    const expectedScope = ethers.keccak256(ethers.toUtf8Bytes(COMMUNITY_SCOPE));
    if (!scope || scope !== expectedScope) {
      logger.warn(ROUTE, 'Scope mismatch', { challengeId, scope, expectedScope });
      return NextResponse.json(
        { error: 'Scope mismatch: proof was not generated for this community' },
        { status: 400 },
      );
    }

    // Extract nullifier as userId
    const nullifier = extractNullifierFromPublicInputs(normalizedInputs, circuit);
    if (!nullifier) {
      logger.warn(ROUTE, 'Failed to extract nullifier', { challengeId });
      return NextResponse.json(
        { error: 'Failed to extract nullifier from proof' },
        { status: 400 },
      );
    }

    // Create or get user
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, nullifier),
    });

    const needsNickname = !existingUser;

    if (!existingUser) {
      const tempNickname = `anon_${nullifier.slice(2, 10)}`;
      await db.insert(users).values({
        id: nullifier,
        nickname: tempNickname,
      });
      logger.info(ROUTE, 'New user created', { challengeId, nullifier, tempNickname });
    } else {
      logger.info(ROUTE, 'Existing user found', { challengeId, nullifier });
    }

    const nickname = existingUser?.nickname ?? `anon_${nullifier.slice(2, 10)}`;
    const token = await createSession(nullifier, nickname);

    logger.info(ROUTE, 'Session created, sending 200', { challengeId, nullifier, needsNickname });

    const response = NextResponse.json({
      userId: nullifier,
      needsNickname,
      token,
    });

    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
