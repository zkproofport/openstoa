-- On-chain recording feature
CREATE TABLE IF NOT EXISTS "community_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "community_posts"("id"),
  "recorder_nullifier" text NOT NULL REFERENCES "community_users"("id"),
  "content_hash" text NOT NULL,
  "tx_hash" text,
  "method" varchar(10) NOT NULL DEFAULT 'service',
  "status" varchar(10) NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "community_record_post_recorder_idx" ON "community_records" ("post_id", "recorder_nullifier");
CREATE INDEX IF NOT EXISTS "community_record_post_idx" ON "community_records" ("post_id");

CREATE TABLE IF NOT EXISTS "community_record_limits" (
  "user_id" text NOT NULL REFERENCES "community_users"("id"),
  "date" text NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("user_id", "date")
);

-- Add record count cache to posts
ALTER TABLE "community_posts" ADD COLUMN IF NOT EXISTS "record_count" integer NOT NULL DEFAULT 0;

-- Add total recorded count to users
ALTER TABLE "community_users" ADD COLUMN IF NOT EXISTS "total_recorded" integer NOT NULL DEFAULT 0;
