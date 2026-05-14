-- pg_trgm trigram indexes accelerate the `?q=` substring search used by
-- /api/feed and /api/topics. Without these, `ilike '%term%'` falls back
-- to a sequential scan and stays linear in row count — fine on dev,
-- catastrophic in production as the table grows.
--
-- IF NOT EXISTS makes this re-runnable. The auto-migrator at boot in
-- src/lib/db/migrate.ts already skips "already exists" errors, but
-- staying idempotent here keeps psql / Drizzle Kit consistent too.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS posts_title_trgm_idx
  ON posts USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS posts_content_trgm_idx
  ON posts USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS topics_title_trgm_idx
  ON topics USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS topics_description_trgm_idx
  ON topics USING gin (description gin_trgm_ops);
