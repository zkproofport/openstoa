CREATE TABLE "community_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"icon" varchar(10),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "community_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_record_limits" (
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "community_record_limits_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "community_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"recorder_nullifier" text NOT NULL,
	"content_hash" text NOT NULL,
	"tx_hash" text,
	"method" varchar(10) DEFAULT 'service' NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "record_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community_topics" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "community_users" ADD COLUMN "total_recorded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community_record_limits" ADD CONSTRAINT "community_record_limits_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_records" ADD CONSTRAINT "community_records_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_records" ADD CONSTRAINT "community_records_recorder_nullifier_community_users_id_fk" FOREIGN KEY ("recorder_nullifier") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_record_post_recorder_idx" ON "community_records" USING btree ("post_id","recorder_nullifier");--> statement-breakpoint
CREATE INDEX "community_record_post_idx" ON "community_records" USING btree ("post_id");--> statement-breakpoint
ALTER TABLE "community_topics" ADD CONSTRAINT "community_topics_category_id_community_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."community_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "community_categories" ("name", "slug", "icon", "sort_order") VALUES
  ('Base & Layer 2', 'base-layer2', '🔵', 1),
  ('DeFi & Trading', 'defi-trading', '📈', 2),
  ('NFT & Gaming', 'nft-gaming', '🎮', 3),
  ('Privacy & ZK', 'privacy-zk', '🔐', 4),
  ('Development', 'development', '💻', 5),
  ('Governance', 'governance', '🏛️', 6),
  ('Free Talk', 'free-talk', '💬', 7),
  ('Announcements', 'announcements', '📢', 8)
ON CONFLICT ("slug") DO NOTHING;