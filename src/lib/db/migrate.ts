import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

let migrated = false;

export async function runMigrations(): Promise<void> {
  if (migrated) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    // Baseline: if tables exist but no migration journal, mark initial migration as applied
    const check = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='community_users') as has_tables,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='__drizzle_migrations') as has_journal
    `);
    const { has_tables, has_journal } = check.rows[0];

    if (has_tables && !has_journal) {
      console.log('[DB] Existing tables without migration journal detected, baselining...');
      await pool.query(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const journalPath = path.join(process.cwd(), 'drizzle', 'meta', '_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
      for (const entry of journal.entries) {
        await pool.query(
          `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
          [entry.tag, entry.when]
        );
        console.log(`[DB] Baselined migration: ${entry.tag}`);
      }
    }

    await migrate(db, {
      migrationsFolder: path.join(process.cwd(), 'drizzle'),
    });
    console.log('[DB] Drizzle migration completed');
    migrated = true;
  } finally {
    await pool.end();
  }
}
