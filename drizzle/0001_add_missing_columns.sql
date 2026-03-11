-- Add new columns to existing tables that were skipped by CREATE TABLE IF NOT EXISTS
ALTER TABLE "community_posts" ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_topics" ADD COLUMN IF NOT EXISTS "visibility" varchar(10) DEFAULT 'public' NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_topics" ADD COLUMN IF NOT EXISTS "score" real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_topics" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "community_topic_members" ADD COLUMN IF NOT EXISTS "role" varchar(10) DEFAULT 'member' NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_users" ADD COLUMN IF NOT EXISTS "profile_image" text;
--> statement-breakpoint
ALTER TABLE "community_users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;