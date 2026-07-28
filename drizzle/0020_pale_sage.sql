CREATE TABLE "ai_permissions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"cmd" text[] DEFAULT '{}' NOT NULL,
	"history_grant" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DROP TABLE IF EXISTS "ai_grants" CASCADE;--> statement-breakpoint
ALTER TABLE "ai_permissions" ADD CONSTRAINT "ai_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;