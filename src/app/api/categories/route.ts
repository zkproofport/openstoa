import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
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
/**
 * @openapi
 * /api/categories:
 *   post:
 *     tags: [Categories]
 *     summary: Create a new category
 *     operationId: createCategory
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               icon:
 *                 type: string
 *               sortOrder:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Category created
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { name, slug, description, icon, sortOrder } = body;

    if (!name || !slug) {
      return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });
    }

    const [category] = await db
      .insert(categories)
      .values({
        name,
        slug,
        description: description ?? null,
        icon: icon ?? null,
        sortOrder: sortOrder ?? 0,
      })
      .returning();

    logger.info(ROUTE, 'Category created', { id: category.id, name });
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Error creating category', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

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
