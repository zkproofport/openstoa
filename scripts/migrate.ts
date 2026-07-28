/**
 * Apply pending migrations using the same runner the server uses at boot
 * (see src/instrumentation.ts).
 *
 * `drizzle-kit migrate` (npm run db:migrate) cannot be used for this: against a
 * fresh database it aborts with a column-name collision and creates no tables.
 * src/lib/db/migrate.ts replays the journal statement-by-statement instead and
 * tolerates "already exists", which is what both boot and CI need.
 */
import { runMigrations } from '../src/lib/db/migrate';

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
