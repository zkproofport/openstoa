-- "Please unlock the history for me".
--
-- After a recovery on a new phone, private / secret / DM rooms open only as far
-- as the OLD phone's last backup: epochs that advanced while it was off were
-- never in that device's keychain, so they were never in the blob. The one
-- place those keys still exist is another member's device — so somebody has to
-- be asked, and the asking has to survive the moment, because the member who
-- can grant is usually not looking at their phone right now.
--
-- IDEMPOTENT by construction (IF NOT EXISTS): migrations run on boot from
-- `migrate.ts`, and a container that restarts mid-deploy must not fail on a
-- table it already created.
CREATE TABLE IF NOT EXISTS "key_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "topic_id" uuid NOT NULL REFERENCES "topics"("id"),
  "requester_user_id" text NOT NULL,
  "requester_device_id" text NOT NULL,
  "have_from_epoch" integer,
  "granted_at" timestamp with time zone,
  "granted_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now()
);

-- Members list the OPEN requests they could answer.
CREATE INDEX IF NOT EXISTS "key_requests_topic_idx"
  ON "key_requests" ("topic_id", "granted_at");

-- One request per device per topic. Without it a screen that retries on mount
-- turns one person's tap into a queue nobody will read to the end, and the
-- second row would tell a granting member nothing the first did not.
CREATE UNIQUE INDEX IF NOT EXISTS "key_requests_one_open_idx"
  ON "key_requests" ("topic_id", "requester_device_id");
