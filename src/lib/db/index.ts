import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Fix Cloud SQL Unix socket URLs that use the `@/dbname?host=/cloudsql/...` format.
 * Node.js URL parser rejects empty host after `@`, so we insert `localhost`
 * which gets overridden by the `host` query parameter for Unix socket connections.
 */
function fixCloudSqlUrl(url: string): string {
  // postgresql://user:pass@/dbname?host=/cloudsql/... → insert localhost
  if (url.includes('@/') && url.includes('host=/cloudsql/')) {
    return url.replace('@/', '@localhost/');
  }
  return url;
}

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const client = postgres(fixCloudSqlUrl(url));
    _db = drizzle(client, { schema });
  }
  return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
});
