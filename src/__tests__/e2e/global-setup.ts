import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

const CACHE_FILE = resolve(__dirname, '../../../.e2e-token-cache.json');
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

interface TokenCache {
  token: string;
  userId: string;
  nickname: string;
  createdAt: number;
}

export async function setup() {
  // Load .env.test
  config({ path: resolve(__dirname, '../../../.env.test') });

  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) throw new Error('E2E_BASE_URL is required in .env.test');

  // Check cache
  if (existsSync(CACHE_FILE)) {
    try {
      const cached: TokenCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      if (Date.now() - cached.createdAt < MAX_AGE_MS) {
        console.log(`[E2E Setup] Using cached token (age: ${Math.round((Date.now() - cached.createdAt) / 60000)}min)`);
        // Set env vars for test files
        process.env.E2E_AUTH_TOKEN = cached.token;
        process.env.E2E_USER_ID = cached.userId;
        process.env.E2E_NICKNAME = cached.nickname;
        return;
      }
      console.log('[E2E Setup] Cached token expired, regenerating...');
    } catch {
      console.log('[E2E Setup] Cache file corrupt, regenerating...');
    }
  }

  // Check if manual token is provided
  if (process.env.E2E_AUTH_TOKEN) {
    console.log('[E2E Setup] Using manually provided E2E_AUTH_TOKEN');
    return;
  }

  console.log('[E2E Setup] Generating new auth token via ZK proof flow...');

  // Step 1: Get challenge
  const challengeRes = await fetch(`${baseUrl}/api/auth/challenge`, { method: 'POST' });
  if (!challengeRes.ok) throw new Error(`Challenge failed: ${challengeRes.status}`);
  const { challengeId, scope } = await challengeRes.json();
  console.log(`[E2E Setup] Challenge created: ${challengeId}, scope: ${scope}`);

  // Step 2: Generate ZK proof using AI SDK (staging AI for Base Sepolia payment)
  const { createConfig, generateProof, fromPrivateKey } = await import('@zkproofport-ai/sdk');

  const aiConfig = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });

  const attestationKey = process.env.E2E_ATTESTATION_WALLET_KEY;
  const payerKey = process.env.E2E_PAYER_WALLET_KEY;
  if (!attestationKey) throw new Error('E2E_ATTESTATION_WALLET_KEY is required');
  if (!payerKey) throw new Error('E2E_PAYER_WALLET_KEY is required');

  const attestationSigner = fromPrivateKey(attestationKey);
  const paymentSigner = fromPrivateKey(payerKey);

  console.log('[E2E Setup] Generating ZK proof (this takes 30-90 seconds)...');

  const proofResult = await generateProof(
    aiConfig,
    { attestation: attestationSigner, payment: paymentSigner },
    { circuit: 'coinbase_kyc', scope },
    {
      onStep: (step) => console.log(`[E2E Setup] Step ${step.step}: ${step.name} (${step.durationMs}ms)`),
    },
  );

  console.log('[E2E Setup] Proof generated successfully');

  // Step 3: Verify proof and get token
  const verifyRes = await fetch(`${baseUrl}/api/auth/verify/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      paymentTxHash: proofResult.paymentTxHash,
      result: {
        proof: proofResult.proof,
        publicInputs: proofResult.publicInputs,
        proofWithInputs: proofResult.proofWithInputs,
        verification: proofResult.verification,
        attestation: proofResult.attestation,
        timing: proofResult.timing,
      },
    }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.text();
    throw new Error(`Verify failed: ${verifyRes.status} ${err}`);
  }

  const { userId, token, needsNickname } = await verifyRes.json();
  const nickname = needsNickname ? `anon_${userId.slice(2, 10)}` : userId.slice(2, 10);
  console.log(`[E2E Setup] Authenticated as ${userId} (needsNickname: ${needsNickname})`);

  // Cache the token
  const cache: TokenCache = { token, userId, nickname, createdAt: Date.now() };
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`[E2E Setup] Token cached to ${CACHE_FILE}`);

  // Set env vars for test files
  process.env.E2E_AUTH_TOKEN = token;
  process.env.E2E_USER_ID = userId;
  process.env.E2E_NICKNAME = nickname;
}
