/**
 * MCP E2E: Proof-gated topic creation and join via MCP tools.
 *
 * Two MCP sessions (User A, User B) authenticate via the `authenticate` tool
 * (server-side device flow + Playwright), then:
 *   - User A creates KYC-gated and country-gated topics
 *   - User B joins each topic by generating Coinbase proofs client-side
 *     and submitting via the MCP `post_topics_topicId_join` tool
 *
 * Requires .env.test:
 *   E2E_GOOGLE_USER_A, E2E_GOOGLE_USER_B, E2E_ATTESTATION_WALLET_KEY
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync } from 'child_process';
import { enterDeviceCode } from './playwright-device-flow';

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';
const MCP_URL = new URL('/mcp', BASE_URL);
const SCOPE = 'zkproofport-community';

type ToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean };

function parseJson(r: ToolResult): Record<string, unknown> {
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

function getProveEnv(): NodeJS.ProcessEnv {
  const key = process.env.E2E_ATTESTATION_WALLET_KEY;
  if (!key) throw new Error('E2E_ATTESTATION_WALLET_KEY required in .env.test');
  return { ...process.env, ATTESTATION_KEY: key };
}

function runProveCoinbase(args: string): Record<string, unknown> {
  const cmd = `npx zkproofport-prove ${args} --scope ${SCOPE} --silent 2>/dev/null`;
  console.log(`[MCP-E2E] Coinbase prove: ${cmd}`);
  const result = execSync(cmd, { env: getProveEnv(), timeout: 180_000, encoding: 'utf-8' }) as string;
  console.log('[MCP-E2E] Coinbase proof completed');
  return JSON.parse(result.trim());
}

async function createMcpClient(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(MCP_URL);
  const client = new Client({ name: 'mcp-proof-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function authenticateViaMcp(
  client: Client,
  label: string,
  accountEmail?: string,
): Promise<Record<string, unknown>> {
  console.log(`[MCP-E2E] ${label}: authenticate phase 1`);
  const phase1 = parseJson(
    (await client.callTool({ name: 'authenticate', arguments: {} })) as ToolResult,
  );
  expect(phase1.status).toBe('pending_user_login');
  const { verificationUrl, userCode } = phase1 as { verificationUrl: string; userCode: string };
  console.log(`[MCP-E2E] ${label}: device code=${userCode}`);

  // Fire phase 2 (blocks) + Playwright device flow in parallel
  const [phase2Settlement] = await Promise.allSettled([
    client.callTool({ name: 'authenticate', arguments: {} }, undefined, { timeout: 180_000 }),
    enterDeviceCode('google', userCode, accountEmail),
  ]);

  expect(phase2Settlement.status).toBe('fulfilled');
  const phase2 = parseJson((phase2Settlement as PromiseFulfilledResult<ToolResult>).value);
  expect(phase2.status).toBe('authenticated');
  console.log(`[MCP-E2E] ${label}: authenticated (userId=${(phase2.userId as string)?.slice(0, 12)}...)`);
  return phase2;
}

// ─── Shared state ──────────────────────────────────────────────────────
let clientA: Client;
let clientB: Client;
let transportA: StreamableHTTPClientTransport;
let transportB: StreamableHTTPClientTransport;
let categoryId: string;
let kycTopicId: string;
let countryTopicId: string;

describe.sequential('MCP Proof-gated topic join E2E', () => {
  // ═════════════════════════════════════════════════════════════════════
  // SETUP: Create clients + authenticate both users
  // ═════════════════════════════════════════════════════════════════════

  beforeAll(async () => {
    ({ client: clientA, transport: transportA } = await createMcpClient());
    ({ client: clientB, transport: transportB } = await createMcpClient());
  }, 30_000);

  afterAll(async () => {
    await clientA?.close();
    await clientB?.close();
  });

  it('User A: authenticate via MCP', async () => {
    await authenticateViaMcp(clientA, 'User A', process.env.E2E_GOOGLE_USER_A);
  }, 300_000);

  it('User B: authenticate via MCP', async () => {
    await authenticateViaMcp(clientB, 'User B', process.env.E2E_GOOGLE_USER_B);
  }, 300_000);

  it('setup: get category ID', async () => {
    const res = parseJson(
      (await clientA.callTool({ name: 'get_categories', arguments: {} })) as ToolResult,
    );
    const categories = res.categories as Array<{ id: string }>;
    expect(categories.length).toBeGreaterThan(0);
    categoryId = categories[0].id;
  });

  // ═════════════════════════════════════════════════════════════════════
  // USER A: Create proof-gated topics
  // ═════════════════════════════════════════════════════════════════════

  it('User A: create KYC-gated topic', async () => {
    const proofResult = runProveCoinbase('coinbase_kyc');
    const res = parseJson(
      (await clientA.callTool({
        name: 'post_topics',
        arguments: {
          title: `MCP-E2E KYC ${Date.now()}`,
          description: 'KYC required to join',
          categoryId,
          proofType: 'kyc',
          proof: proofResult.proof,
          publicInputs: proofResult.publicInputs,
        },
      })) as ToolResult,
    );
    expect(res.topic).toBeDefined();
    kycTopicId = (res.topic as { id: string }).id;
    console.log(`[MCP-E2E] KYC topic created: ${kycTopicId}`);
  }, 180_000);

  it('User A: create country-gated topic (KR)', async () => {
    const proofResult = runProveCoinbase('coinbase_country --countries KR --included true');
    const res = parseJson(
      (await clientA.callTool({
        name: 'post_topics',
        arguments: {
          title: `MCP-E2E Country ${Date.now()}`,
          description: 'KR only',
          categoryId,
          proofType: 'country',
          requiresCountryProof: true,
          allowedCountries: ['KR'],
          countryMode: 'include',
          proof: proofResult.proof,
          publicInputs: proofResult.publicInputs,
        },
      })) as ToolResult,
    );
    expect(res.topic).toBeDefined();
    countryTopicId = (res.topic as { id: string }).id;
    console.log(`[MCP-E2E] Country topic created: ${countryTopicId}`);
  }, 180_000);

  // ═════════════════════════════════════════════════════════════════════
  // USER B: Join proof-gated topics via MCP
  // ═════════════════════════════════════════════════════════════════════

  it('User B: join KYC topic without proof → 402', async () => {
    const res = (await clientB.callTool({
      name: 'post_topics_topicId_join',
      arguments: { topicId: kycTopicId },
    })) as ToolResult;
    const parsed = parseJson(res);
    // Should return error (402 from server → MCP error)
    expect(res.isError || parsed.error || parsed.proofRequirement).toBeTruthy();
    if (parsed.proofRequirement) {
      const req = parsed.proofRequirement as { type: string; mcp?: Record<string, unknown> };
      expect(req.type).toBe('kyc');
      // Verify the mcp guidance is present
      expect(req.mcp).toBeDefined();
      console.log(`[MCP-E2E] 402 returned with mcp.preferredTool=${(req.mcp as Record<string, unknown>)?.preferredTool}`);
    }
  });

  it('User B: join KYC topic WITH proof', async () => {
    const proofResult = runProveCoinbase('coinbase_kyc');
    const res = parseJson(
      (await clientB.callTool({
        name: 'post_topics_topicId_join',
        arguments: {
          topicId: kycTopicId,
          proof: proofResult.proof,
          publicInputs: proofResult.publicInputs,
        },
      })) as ToolResult,
    );
    // 201 = joined, or already joined via cache (success either way)
    expect(res.success ?? res.error?.toString().includes('Already')).toBeTruthy();
    console.log(`[MCP-E2E] User B joined KYC topic: ${JSON.stringify(res).slice(0, 200)}`);
  }, 180_000);

  it('User B: join country topic WITHOUT proof → 402', async () => {
    const res = (await clientB.callTool({
      name: 'post_topics_topicId_join',
      arguments: { topicId: countryTopicId },
    })) as ToolResult;
    const parsed = parseJson(res);
    expect(res.isError || parsed.error || parsed.proofRequirement).toBeTruthy();
  });

  it('User B: join country topic WITH proof', async () => {
    const proofResult = runProveCoinbase('coinbase_country --countries KR --included true');
    const res = parseJson(
      (await clientB.callTool({
        name: 'post_topics_topicId_join',
        arguments: {
          topicId: countryTopicId,
          proof: proofResult.proof,
          publicInputs: proofResult.publicInputs,
        },
      })) as ToolResult,
    );
    expect(res.success ?? res.error?.toString().includes('Already')).toBeTruthy();
    console.log(`[MCP-E2E] User B joined Country topic: ${JSON.stringify(res).slice(0, 200)}`);
  }, 180_000);

  it('User B: join KYC topic again → 409 already member', async () => {
    const res = (await clientB.callTool({
      name: 'post_topics_topicId_join',
      arguments: { topicId: kycTopicId },
    })) as ToolResult;
    const parsed = parseJson(res);
    expect(
      (parsed.error as string)?.includes('Already') || res.isError,
    ).toBeTruthy();
  });

  // ═════════════════════════════════════════════════════════════════════
  // VERIFY: proof guide mcp field is populated
  // ═════════════════════════════════════════════════════════════════════

  it('get_docs_proof_guide for kyc includes mcp guidance', async () => {
    const res = parseJson(
      (await clientA.callTool({
        name: 'get_docs_proof_guide_proofType',
        arguments: { proofType: 'kyc' },
      })) as ToolResult,
    );
    expect(res.mcp).toBeDefined();
    expect((res.mcp as Record<string, unknown>).preferredTool).toBeNull();
    expect((res.mcp as Record<string, unknown>).explanation).toContain('private key');
  });

  it('get_docs_proof_guide for google_workspace includes mcp tool name', async () => {
    const res = parseJson(
      (await clientA.callTool({
        name: 'get_docs_proof_guide_proofType',
        arguments: { proofType: 'google_workspace' },
      })) as ToolResult,
    );
    expect(res.mcp).toBeDefined();
    expect((res.mcp as Record<string, unknown>).preferredTool).toBe('join_topic_with_google_workspace');
  });
});
