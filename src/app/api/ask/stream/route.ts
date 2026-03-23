import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { getAskSystemPrompt } from '@/lib/askSystemPrompt';

const ROUTE = '/api/ask/stream';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function* streamGemini(messages: ChatMessage[], systemPrompt: string): AsyncGenerator<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`,
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

  if (!res.body) throw new Error('Gemini returned empty body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(jsonStr);
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        // skip malformed chunk
      }
    }
  }
}

async function* streamOpenAI(messages: ChatMessage[], systemPrompt: string): AsyncGenerator<string> {
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
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${err}`);
  }

  if (!res.body) throw new Error('OpenAI returned empty body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(jsonStr);
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // skip malformed chunk
      }
    }
  }
}

/**
 * @openapi
 * /api/ask/stream:
 *   post:
 *     tags: [AI]
 *     summary: Ask a question about OpenStoa (SSE streaming)
 *     description: Same as /api/ask but returns tokens as Server-Sent Events for real-time display. Uses Gemini streaming (primary) with OpenAI streaming fallback. Each SSE event contains a partial text chunk. The stream ends with a `[DONE]` event.
 *     operationId: askQuestionStream
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
 *         description: SSE stream of text chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: "data: {\"text\":\"Hello\"}\n\ndata: [DONE]\n\n"
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');

  let chatMessages: ChatMessage[];

  try {
    const body = await request.json();
    const { question, messages } = body;

    if (messages && Array.isArray(messages)) {
      if (messages.length === 0) {
        return new Response(JSON.stringify({ error: 'messages array is empty' }), { status: 400 });
      }
      chatMessages = messages.map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : ('user' as const),
        content: String(m.content ?? '').slice(0, 2000),
      }));
    } else if (question && typeof question === 'string' && question.trim().length > 0) {
      if (question.length > 1000) {
        return new Response(JSON.stringify({ error: 'Question too long (max 1000 characters)' }), { status: 400 });
      }
      chatMessages = [{ role: 'user', content: question.trim() }];
    } else {
      return new Response(JSON.stringify({ error: 'question or messages is required' }), { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), { status: 400 });
  }

  // Build system prompt with public URL (Docker internal origin is not publicly accessible)
  const baseUrl = process.env.APP_ENV === 'production'
    ? 'https://www.openstoa.xyz'
    : request.nextUrl.origin;
  const systemPrompt = getAskSystemPrompt(baseUrl);

  const stream = new ReadableStream({
    async start(controller) {
      const encode = (s: string) => new TextEncoder().encode(s);

      async function pipeGenerator(gen: AsyncGenerator<string>, provider: string) {
        try {
          for await (const chunk of gen) {
            controller.enqueue(encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
          }
          controller.enqueue(encode(`data: ${JSON.stringify({ provider })}\n\n`));
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          controller.enqueue(encode(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`));
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        }
      }

      // Try Gemini first, fallback to OpenAI
      try {
        await pipeGenerator(streamGemini(chatMessages, systemPrompt), 'gemini');
        logger.info(ROUTE, 'Streamed via Gemini');
      } catch (geminiError) {
        logger.warn(ROUTE, 'Gemini streaming failed, trying OpenAI', {
          error: geminiError instanceof Error ? geminiError.message : String(geminiError),
        });
        try {
          await pipeGenerator(streamOpenAI(chatMessages, systemPrompt), 'openai');
          logger.info(ROUTE, 'Streamed via OpenAI');
        } catch (openaiError) {
          logger.error(ROUTE, 'Both LLM providers failed for streaming', {
            gemini: geminiError instanceof Error ? geminiError.message : String(geminiError),
            openai: openaiError instanceof Error ? openaiError.message : String(openaiError),
          });
          controller.enqueue(encode('data: ' + JSON.stringify({ error: 'AI service unavailable. Please try again later.' }) + '\n\n'));
          controller.enqueue(encode('data: [DONE]\n\n'));
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
