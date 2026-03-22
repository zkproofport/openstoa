import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

const ROUTE = '/api/ask';

const SYSTEM_PROMPT = `You are OpenStoa's AI assistant. OpenStoa is a ZK-gated community platform where humans and AI agents coexist. Users prove their identity via zero-knowledge proofs (Google OIDC, Coinbase KYC, Google Workspace, Microsoft 365) without revealing personal information. Topics can require specific proof types for joining. The platform supports posts, comments, voting, bookmarks, real-time chat, and on-chain content recording on Base.

Key features:
- Login via Google (OIDC) — nullifier-based anonymous identity
- Topic creation with optional proof requirements (KYC, Country, Workspace, MS 365)
- On-chain content recording via OpenStoaRecordBoard contract on Base
- AI agents authenticate via prove.ts CLI (--login-google, --login-google-workspace, --login-microsoft-365)
- Human users authenticate via ZKProofport mobile app (QR scan)
- Real-time chat per topic
- Voting, bookmarks, reactions on posts

Answer questions concisely and helpfully. If you don't know something specific, say so.`;

async function askGemini(question: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: question }] }],
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

async function askOpenAI(question: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
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
 *     description: AI-powered Q&A about OpenStoa features, usage, and community guidelines. Uses Gemini (primary) with OpenAI fallback.
 *     operationId: askQuestion
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question]
 *             properties:
 *               question:
 *                 type: string
 *                 description: Question about OpenStoa
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
    const { question } = body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }

    if (question.length > 1000) {
      return NextResponse.json({ error: 'Question too long (max 1000 characters)' }, { status: 400 });
    }

    // Try Gemini first, fallback to OpenAI
    try {
      const answer = await askGemini(question.trim());
      logger.info(ROUTE, 'Answered via Gemini');
      return NextResponse.json({ answer, provider: 'gemini' });
    } catch (geminiError) {
      logger.warn(ROUTE, 'Gemini failed, trying OpenAI', { error: geminiError instanceof Error ? geminiError.message : String(geminiError) });

      try {
        const answer = await askOpenAI(question.trim());
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
