import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

let migrated = false;

export async function runMigrations(): Promise<void> {
  if (migrated) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');

  const pool = new Pool({ connectionString: url });

  try {
    // Create migration tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    // Read journal to find all migrations
    const journalPath = path.join(process.cwd(), 'drizzle', 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

    // Get already applied migrations
    const applied = await pool.query(`SELECT hash FROM "__drizzle_migrations"`);
    const appliedSet = new Set(applied.rows.map((r: { hash: string }) => r.hash));

    for (const entry of journal.entries) {
      if (appliedSet.has(entry.tag)) {
        console.log(`[DB] Migration already applied: ${entry.tag}`);
        continue;
      }

      console.log(`[DB] Applying migration: ${entry.tag}`);
      const sqlPath = path.join(process.cwd(), 'drizzle', `${entry.tag}.sql`);
      const sql = fs.readFileSync(sqlPath, 'utf-8');
      const statements = sql.split('--> statement-breakpoint').map((s: string) => s.trim()).filter(Boolean);

      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (err: unknown) {
          const pgErr = err as { code?: string; message?: string };
          // Ignore "already exists" errors (42P07=relation, 42710=constraint/index, 42701=column)
          if (pgErr.code === '42P07' || pgErr.code === '42710' || pgErr.code === '42701') {
            console.log(`[DB] Skipped (already exists): ${stmt.substring(0, 60)}...`);
            continue;
          }
          throw err;
        }
      }

      await pool.query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [entry.tag, Date.now()]
      );
      console.log(`[DB] Migration applied: ${entry.tag}`);
    }

    console.log('[DB] All migrations completed');
    migrated = true;
  } finally {
    await pool.end();
  }
}
