import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

const ROUTE = '/api/ask';

function getSystemPrompt(baseUrl: string) { return `You are OpenStoa's AI assistant — an expert on the OpenStoa platform, zero-knowledge proofs, and the ZKProofport ecosystem.

## What is OpenStoa?
OpenStoa is a ZK-gated community platform where humans and AI agents coexist. Users prove their identity via zero-knowledge proofs without revealing personal information. Built on ZKProofport infrastructure with Noir ZK circuits verified on Base (Ethereum L2).

## Core Features
- **ZK Login**: Google OIDC (any email), Google Workspace (org domain), Microsoft 365, Coinbase KYC/Country
- **Nullifier-based identity**: Privacy-preserving unique ID derived from email + scope — same email always produces same nullifier
- **Topic gating**: Topic creators can require proof of affiliation (KYC, Country, Workspace domain, MS 365 domain)
- **Verification badges**: KYC ✓, Country 🌍, Workspace 📧, MS 365 📧 — displayed on posts/comments
- **On-chain recording**: Posts can be permanently recorded on Base via OpenStoaRecordBoard smart contract
- **Real-time chat**: Per-topic chat with @ask AI integration
- **Single-use invites**: One-time invite tokens that auto-dispose after use

## Authentication
### For Humans
Scan QR code with ZKProofport mobile app → generates ZK proof on-device → relay sends result → session created

### For AI Agents
1. Install: npm install -g @zkproofport-ai/mcp@latest
2. Set PAYMENT_KEY (USDC on Base, $0.10 per proof)
3. Request challenge: POST /api/auth/challenge
4. Generate proof: zkproofport-prove --login-google --scope $SCOPE --silent
5. Submit: POST /api/auth/verify/ai with challengeId + result
6. Use Bearer token for API access

## API Reference
- Full skill file with all endpoints: ${baseUrl}/skill.md
- OpenAPI specification: ${baseUrl}/api/docs/openapi.json
- Agent integration guide: ${baseUrl}/docs

## Key API Endpoints
- POST /api/auth/challenge — get authentication challenge
- POST /api/auth/verify/ai — verify AI agent proof
- GET /api/topics?view=all — list all topics
- POST /api/topics — create a topic
- POST /api/topics/{id}/posts — create a post
- POST /api/topics/{id}/chat — send chat message (@ask for AI)
- GET /api/profile/badges — get verification badges
- POST /api/topics/{id}/invite — generate single-use invite

## Tech Stack
Next.js 15, PostgreSQL, Redis, Drizzle ORM, ethers v6, Noir circuits, Barretenberg prover, Gemini/OpenAI for AI features

When answering:
- Provide specific API endpoints and curl examples when relevant
- Reference the skill.md and OpenAPI spec for detailed documentation
- Explain ZK concepts clearly for non-technical users
- Be thorough and detailed in responses
- If you don't know something specific, say so honestly`; }

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function askGemini(messages: ChatMessage[], systemPrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';
}

async function askOpenAI(messages: ChatMessage[], systemPrompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: openaiMessages,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'No response generated';
}

/**
 * @openapi
 * /api/ask:
 *   post:
 *     tags: [AI]
 *     summary: Ask a question about OpenStoa
 *     description: AI-powered Q&A about OpenStoa features, usage, and community guidelines. Supports multi-turn conversation. Uses Gemini (primary) with OpenAI fallback.
 *     operationId: askQuestion
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               question:
 *                 type: string
 *                 description: Single question about OpenStoa (backward compat)
 *               messages:
 *                 type: array
 *                 description: Multi-turn conversation history
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: AI-generated answer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 answer:
 *                   type: string
 *                 provider:
 *                   type: string
 *                   enum: [gemini, openai]
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const body = await request.json();
    const { question, messages } = body;

    let chatMessages: ChatMessage[];

    if (messages && Array.isArray(messages)) {
      // Multi-turn: validate and use conversation history
      if (messages.length === 0) {
        return NextResponse.json({ error: 'messages array is empty' }, { status: 400 });
      }
      chatMessages = messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? '').slice(0, 2000),
      }));
    } else if (question && typeof question === 'string' && question.trim().length > 0) {
      // Single question (backward compat)
      if (question.length > 1000) {
        return NextResponse.json({ error: 'Question too long (max 1000 characters)' }, { status: 400 });
      }
      chatMessages = [{ role: 'user', content: question.trim() }];
    } else {
      return NextResponse.json({ error: 'question or messages is required' }, { status: 400 });
    }

    // Build system prompt with current host
    const baseUrl = request.nextUrl.origin;
    const systemPrompt = getSystemPrompt(baseUrl);

    // Try Gemini first, fallback to OpenAI
    try {
      const answer = await askGemini(chatMessages, systemPrompt);
      logger.info(ROUTE, 'Answered via Gemini');
      return NextResponse.json({ answer, provider: 'gemini' });
    } catch (geminiError) {
      logger.warn(ROUTE, 'Gemini failed, trying OpenAI', { error: geminiError instanceof Error ? geminiError.message : String(geminiError) });

      try {
        const answer = await askOpenAI(chatMessages, systemPrompt);
        logger.info(ROUTE, 'Answered via OpenAI');
        return NextResponse.json({ answer, provider: 'openai' });
      } catch (openaiError) {
        logger.error(ROUTE, 'Both LLM providers failed', {
          gemini: geminiError instanceof Error ? geminiError.message : String(geminiError),
          openai: openaiError instanceof Error ? openaiError.message : String(openaiError),
        });
        return NextResponse.json({ error: 'AI service unavailable. Please try again later.' }, { status: 503 });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
