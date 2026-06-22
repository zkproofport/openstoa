-- P2-22: rename the legacy plaintext `message` column to `system_text`.
-- Idempotent: only renames when `message` still exists and `system_text` does
-- not, so this is safe to (re-)run against a fresh DB (renames), an
-- already-migrated DB, or a `db:push`-built DB (no-op). The boot migrator
-- (src/lib/db/migrate.ts) only skips "already exists" errors, not a rename of a
-- missing column, so the guard is required to avoid crashing startup.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'message'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'system_text'
  ) THEN
    ALTER TABLE "chat_messages" RENAME COLUMN "message" TO "system_text";
  END IF;
END $$;
