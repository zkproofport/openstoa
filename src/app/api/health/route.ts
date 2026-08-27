import { NextResponse } from 'next/server';

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     description: Returns service health status, uptime, and current timestamp.
 *     operationId: getHealth
 *     security: []
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                   description: Health status indicator
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Current server timestamp
 *                 uptime:
 *                   type: number
 *                   description: Process uptime in seconds
 */
/*
 * WHICH BUILD IS ANSWERING — the field this endpoint was missing.
 *
 * A health check that only says "ok" cannot tell a fresh deploy from last
 * week's. On 2026-08-27 a build failed on a corrupt buildkit cache, docker left
 * the OLD container serving, `/api/health` answered 200, and an hour went into
 * diagnosing a feature as broken when the code was correct and simply not
 * deployed — followed by a confidently wrong report.
 *
 * Baked at BUILD time, not read at request time: the point is to identify the
 * artifact, and anything resolved from the environment at runtime can be right
 * while the code is old. `unknown` when the build did not pass them, which is
 * itself the answer to "was this built by our pipeline".
 */
const BUILD = {
  commit: process.env.BUILD_COMMIT ?? 'unknown',
  builtAt: process.env.BUILD_TIME ?? 'unknown',
} as const;

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...BUILD,
  });
}
