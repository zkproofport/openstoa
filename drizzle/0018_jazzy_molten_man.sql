CREATE TABLE "ai_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"granter_user_id" text NOT NULL,
	"ai_user_id" text NOT NULL,
	"cmd" text[] NOT NULL,
	"history_grant" text NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"dpop_jkt" text,
	"consent_anchor" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "ai_grants" ADD CONSTRAINT "ai_grants_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_grants" ADD CONSTRAINT "ai_grants_granter_user_id_users_id_fk" FOREIGN KEY ("granter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_grants_topic_ai_idx" ON "ai_grants" USING btree ("topic_id","ai_user_id");