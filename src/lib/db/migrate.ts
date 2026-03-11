import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';

let migrated = false;

export async function runMigrations(): Promise<void> {
  if (migrated) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    await migrate(db, {
      migrationsFolder: path.join(process.cwd(), 'drizzle'),
    });
    console.log('[DB] Drizzle migration completed');
    migrated = true;
  } finally {
    await pool.end();
  }
}
