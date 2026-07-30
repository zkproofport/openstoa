CREATE TABLE IF NOT EXISTS "push_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_topic_mutes" (
	"user_id" text NOT NULL,
	"topic_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "push_topic_mutes_user_id_topic_id_pk" PRIMARY KEY("user_id","topic_id")
);
--> statement-breakpoint
ALTER TABLE "push_prefs" ADD CONSTRAINT "push_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_topic_mutes" ADD CONSTRAINT "push_topic_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_topic_mutes" ADD CONSTRAINT "push_topic_mutes_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_topic_mutes_user_idx" ON "push_topic_mutes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_topic_mutes_topic_idx" ON "push_topic_mutes" USING btree ("topic_id");