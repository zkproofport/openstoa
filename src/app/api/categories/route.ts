import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { categories } from '@/lib/db/schema';
import { asc } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/categories';

/**
 * @openapi
 * /api/categories:
 *   get:
 *     tags: [Categories]
 *     summary: List all categories
 *     description: Returns all categories sorted by sort order. Public endpoint, no auth required.
 *     operationId: listCategories
 *     security: []
 *     responses:
 *       200:
 *         description: Categories list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       slug:
 *                         type: string
 *                       description:
 *                         type: string
 *                         nullable: true
 *                       icon:
 *                         type: string
 *                         nullable: true
 *                       sortOrder:
 *                         type: integer
 */
export async function GET() {
  logger.info(ROUTE, 'GET request received');
  try {
    const result = await db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder));

    logger.info(ROUTE, 'Categories fetched', { count: result.length });
    return NextResponse.json({ categories: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
