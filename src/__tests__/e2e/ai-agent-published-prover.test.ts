/**
 * An AI agent's proofs, end to end: the PUBLISHED @zkproofport-ai/mcp prove
 * CLI asks the ZKProofport prover (PROOFPORT_URL) for a proof and pays for it,
 * and this deployment (E2E_BASE_URL) verifies it.
 *
 * Nothing here is mocked and nothing comes from a local build: the CLI runs
 * from the exact npm version in E2E_PROVE_MCP_VERSION (`npx -p
 * @zkproofport-ai/mcp@<version>`), the way an agent installs it.
 *
 *   1. OIDC login: POST /api/auth/challenge -> `oidc_domain --jwt` over the
 *      challenge scope -> POST /api/auth/verify/ai -> a session that reads
 *      /api/auth/session. Needs E2E_OIDC_JWT: a Google id_token issued to the
 *      ZKProofport device sign-in client (a person signs in; nothing on this
 *      machine can mint one). Without it the case is SKIPPED, never passed.
 *   2. Coinbase KYC (v2): the logged-in agent (or, without E2E_OIDC_JWT, a
 *      staging dev-login session, said so in the log) asks for its
 *      account-bound topic scope, proves `coinbase_kyc` over it and creates a
 *      KYC-gated topic (201); a second account joins it: 402 without a proof,
 *      201 with its own.
 *
 * Env: E2E_BASE_URL, PROOFPORT_URL, E2E_PROVE_MCP_VERSION (exact x.y.z),
 * E2E_ATTESTATION_WALLET_KEY (Coinbase-attested wallet), E2E_PAYER_WALLET_KEY
 * (testnet USDC on Base Sepolia), optional E2E_OIDC_JWT. Spends testnet USDC.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { getBaseUrl, publicGet, E2E_DEVICE_HEADERS } from './helpers';

const BASE = getBaseUrl();
const MCP_VERSION = process.env.E2E_PROVE_MCP_VERSION ?? '';
const OIDC_JWT = process.env.E2E_OIDC_JWT;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the AI agent prover E2E`);
  return value;
}

/** Runs the published prove CLI. Keys travel in the child's environment only. */
function prove(args: string[]): Record<string, unknown> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(MCP_VERSION)) {
    throw new Error(`E2E_PROVE_MCP_VERSION must be an exact published version; got '${MCP_VERSION}'`);
  }
  const out = execFileSync('npx', [
    '-y', '-p', `@zkproofport-ai/mcp@${MCP_VERSION}`, 'zkproofport-prove',
    ...args, '--pay-with', 'key', '--pay-on', 'base-sepolia', '--silent',
  ], {
    env: {
      ...process.env,
      PROOFPORT_URL: required('PROOFPORT_URL'),
      ATTESTATION_KEY: required('E2E_ATTESTATION_WALLET_KEY'),
      PAYMENT_PRIVATE_KEY: required('E2E_PAYER_WALLET_KEY'),
    },
    timeout: 600_000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(out.trim());
  console.log(`[E2E] @zkproofport-ai/mcp@${MCP_VERSION} ${args[0]}: proof ${(String(result.proof).length - 2) / 2} bytes`);
  return result;
}

function authed(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function devLogin(label: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname: `e2e_ai_${label}_${Date.now().toString(36)}` }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  return (await res.json()).token;
}

async function topicScope(token: string): Promise<string> {
  const res = await authed('/api/auth/challenge', token, { method: 'POST' });
  expect(res.status).toBe(200);
  const { scope } = await res.json();
  expect(scope).toMatch(/^zkproofport-community:topic:/);
  return scope;
}

/** The CLI prints publicInputs as one hex string; the topic gate takes it as is. */
function kycBody(result: Record<string, unknown>) {
  return { proof: result.proof, publicInputs: result.publicInputs };
}

let categoryId: string;
let agentToken: string;
let kycTopicId: string;

beforeAll(async () => {
  const res = await publicGet('/api/categories');
  expect(res.status).toBe(200);
  categoryId = (await res.json()).categories[0].id;
});

describe.sequential('AI agent with the published prove CLI', () => {
  it.skipIf(!OIDC_JWT)('logs in with an OIDC proof from the prover [needs E2E_OIDC_JWT from a human device sign-in]', async () => {
    const challenge = await (await fetch(`${BASE}/api/auth/challenge`, { method: 'POST' })).json();
    expect(challenge.scope).toBe('zkproofport-community');
    const result = prove(['oidc_domain', '--jwt', OIDC_JWT!, '--scope', challenge.scope]);
    const res = await fetch(`${BASE}/api/auth/verify/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: challenge.challengeId, result }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    agentToken = (await res.json()).token;
    expect((await authed('/api/auth/session', agentToken)).status).toBe(200);
  }, 900_000);

  it('creates a KYC-gated topic with a Coinbase KYC proof from the prover', async () => {
    if (!agentToken) {
      console.log('[E2E] no OIDC login session (E2E_OIDC_JWT absent): the KYC step runs on a staging dev-login session');
      agentToken = await devLogin('a');
    }
    const result = prove(['coinbase_kyc', '--scope', await topicScope(agentToken)]);
    expect(Array.isArray(result.publicInputs) ? result.publicInputs.length : (String(result.publicInputs).length - 2) / 64).toBe(193);
    const res = await authed('/api/topics', agentToken, {
      method: 'POST',
      body: JSON.stringify({ title: `E2E AI KYC ${Date.now()}`, description: 'Coinbase KYC v2 from the AI prover', categoryId, proofType: 'kyc', ...kycBody(result) }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    kycTopicId = (await res.json()).topic.id;
  }, 900_000);

  it('a second account joins it: 402 without a proof, 201 with its own Coinbase KYC proof', async () => {
    expect(kycTopicId).toBeTruthy();
    const second = await devLogin('b');
    const refused = await authed(`/api/topics/${kycTopicId}/join`, second, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(402);
    expect((await refused.json()).proofRequirement.circuit).toBe('coinbase_attestation');
    const result = prove(['coinbase_kyc', '--scope', await topicScope(second)]);
    const joined = await authed(`/api/topics/${kycTopicId}/join`, second, { method: 'POST', body: JSON.stringify(kycBody(result)) });
    expect(joined.status, await joined.clone().text()).toBe(201);
  }, 900_000);

  it('the same proof replayed by another account is refused (scope is per account)', async () => {
    expect(kycTopicId).toBeTruthy();
    const first = prove(['coinbase_kyc', '--scope', await topicScope(agentToken)]);
    const third = await devLogin('c');
    const res = await authed(`/api/topics/${kycTopicId}/join`, third, { method: 'POST', body: JSON.stringify(kycBody(first)) });
    expect(res.status).toBe(400);
  }, 900_000);
});
