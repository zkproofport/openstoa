-- Create new tables that were missed during baseline (0000 was skipped for existing DB)
CREATE TABLE IF NOT EXISTS "community_reactions" (
	"user_id" text NOT NULL,
	"post_id" uuid NOT NULL,
	"emoji" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "community_reactions_user_id_post_id_emoji_pk" PRIMARY KEY("user_id","post_id","emoji")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_post_id_community_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."community_posts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_topic_id_community_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."community_topics"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_reviewed_by_community_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "community_join_request_topic_user_idx" ON "community_join_requests" USING btree ("topic_id","user_id");