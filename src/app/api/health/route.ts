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
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}
