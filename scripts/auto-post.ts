#!/usr/bin/env npx tsx
/**
 * Auto-posting script for OpenStoa community.
 * Searches the web for trending content per topic and creates rich posts.
 *
 * Usage:
 *   npx tsx scripts/auto-post.ts              # one-shot: post to one random topic
 *   npx tsx scripts/auto-post.ts --all        # one-shot: post to every topic
 *
 * Environment:
 *   E2E_AUTH_TOKEN   — Bearer token (or reads from .e2e-token-cache.json)
 *   E2E_BASE_URL     — defaults to https://stg-community.zkproofport.app
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';

function getToken(): string {
  if (process.env.E2E_AUTH_TOKEN) return process.env.E2E_AUTH_TOKEN;
  const cache = resolve(__dirname, '../.e2e-token-cache.json');
  if (existsSync(cache)) {
    const { token } = JSON.parse(readFileSync(cache, 'utf-8'));
    return token;
  }
  throw new Error('No auth token available');
}

const TOKEN = getToken();

const TOPICS: { id: string; title: string; queries: string[] }[] = [
  { id: '140d9b8b-925c-41e0-824c-25c77126b7a3', title: 'Base Mainnet Gas Fee Tracker', queries: ['Base L2 gas fees news', 'Base mainnet network update'] },
  { id: '2206cd44-8040-4af8-969d-7ec34dbadc84', title: 'Superchain Interop Updates', queries: ['OP Stack superchain interoperability', 'Optimism Base interop news'] },
  { id: 'ce5a9370-197f-42cd-b787-408915b19dfe', title: 'Stablecoin Wars 2026', queries: ['stablecoin market USDC USDT news', 'stablecoin regulation 2026'] },
  { id: '25f000d2-9aa9-476e-82cf-7212ecabd8f5', title: 'AI Trading Agents', queries: ['AI trading agent crypto', 'autonomous trading bot DeFi'] },
  { id: '9f7566b2-c55c-4270-a8b4-07e298a04c9c', title: 'Onchain Gaming on Base', queries: ['onchain gaming Base blockchain', 'Web3 gaming news'] },
  { id: '0de61013-89f1-418c-bfd4-71ce33892357', title: 'Dynamic NFTs and AI Art', queries: ['dynamic NFT AI art', 'generative art NFT news'] },
  { id: '58314822-5901-4366-a8f0-dadd16229f37', title: 'ZK Identity for AI Agents', queries: ['zero knowledge identity AI agent', 'ZK proof digital identity'] },
  { id: '21391013-8716-4f52-b424-aba9e78a9bd8', title: 'Private Voting with ZK Proofs', queries: ['ZK proof voting privacy', 'anonymous voting blockchain'] },
  { id: '5e7d0cae-9690-4301-ab69-d7ebb4308147', title: 'MCP Servers and Tool Use', queries: ['Model Context Protocol MCP server', 'AI tool use MCP'] },
  { id: 'b4ef0a13-612e-485d-bc56-8561b26f279f', title: 'Noir Circuit Cookbook', queries: ['Noir language ZK circuit', 'Aztec Noir tutorial'] },
  { id: '0afe5705-0b10-4362-a826-c4c5b5e7a198', title: 'Agent DAOs', queries: ['AI agent DAO governance', 'autonomous agent organization'] },
  { id: 'c74eaa48-be40-4d1f-8519-49ed76344738', title: 'Onchain Reputation Systems', queries: ['onchain reputation system', 'soulbound token attestation'] },
  { id: 'a3a963a1-53f7-48c5-b3b8-483c79e39894', title: 'Human vs Agent: Who Writes Better?', queries: ['AI vs human writing quality', 'LLM content creation debate'] },
  { id: '83ab832a-8cec-4d98-8cfa-f0d7205ce34f', title: 'Crypto Culture in Korea', queries: ['Korea crypto market news', 'Korean blockchain regulation'] },
  { id: '77bdebd0-8ed9-4c86-8ce7-c8c3139393b9', title: 'OpenStoa Launch', queries: ['ZK proof community platform', 'privacy-first forum blockchain'] },
  { id: '569f27c7-0091-4904-a1d8-757fc5f1a822', title: 'Synthesis Hackathon 2026', queries: ['Synthesis hackathon crypto AI', 'crypto hackathon 2026'] },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function createPostForTopic(topic: typeof TOPICS[number]) {
  console.log(`[auto-post] Creating post for: ${topic.title}`);

  const query = pickRandom(topic.queries);
  console.log(`[auto-post]   Search query: ${query}`);

  // The actual content generation would be done by an LLM agent.
  // This script is designed to be called from the /loop skill which
  // delegates to an agent with WebSearch capability.
  // For standalone runs, we create a placeholder post.

  const title = `${topic.title} — Latest Update (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`;
  const content = `<p>This is an auto-generated discussion starter for <strong>${topic.title}</strong>.</p>
<p>Search topics of interest: <em>${topic.queries.join(', ')}</em></p>
<p>Share your thoughts and findings in the comments below!</p>`;

  const res = await authPost(`/api/topics/${topic.id}/posts`, {
    title,
    content,
    tags: [topic.title.split(' ')[0].toLowerCase(), 'trending', 'discussion'],
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[auto-post]   FAILED: ${res.status} ${err}`);
    return null;
  }

  const data = await res.json();
  console.log(`[auto-post]   Created post: ${data.post.id}`);
  return data.post;
}

async function main() {
  const mode = process.argv[2];

  if (mode === '--all') {
    console.log(`[auto-post] Posting to ALL ${TOPICS.length} topics`);
    for (const topic of TOPICS) {
      await createPostForTopic(topic);
    }
  } else {
    const topic = pickRandom(TOPICS);
    await createPostForTopic(topic);
  }

  console.log('[auto-post] Done');
}

main().catch((e) => {
  console.error('[auto-post] Fatal error:', e);
  process.exit(1);
});
