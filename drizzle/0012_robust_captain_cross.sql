CREATE TABLE "device_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"key_package" "bytea" NOT NULL,
	"is_ai" boolean DEFAULT false NOT NULL,
	"is_last_resort" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mls_groups" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"group_id" "bytea" NOT NULL,
	"current_epoch" bigint NOT NULL,
	"ciphersuite" text NOT NULL,
	"group_info" "bytea",
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "device_key_packages" ADD CONSTRAINT "device_key_packages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mls_groups" ADD CONSTRAINT "mls_groups_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_kp_user_consumed_idx" ON "device_key_packages" USING btree ("user_id","consumed_at");