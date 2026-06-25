CREATE TABLE "archive_holders" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"holder_user_id" text NOT NULL,
	"holder_device_id" text NOT NULL,
	"epoch_covered" bigint NOT NULL,
	"succession_rank" integer DEFAULT 0 NOT NULL,
	"holder_lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"tak_version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tak_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"recipient_device_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"scope" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "archive_holders" ADD CONSTRAINT "archive_holders_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_holders" ADD CONSTRAINT "archive_holders_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_archive" ADD CONSTRAINT "chat_archive_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tak_bundles" ADD CONSTRAINT "tak_bundles_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tak_bundles" ADD CONSTRAINT "tak_bundles_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_archive_topic_msg_idx" ON "chat_archive" USING btree ("topic_id","message_id");--> statement-breakpoint
CREATE INDEX "chat_archive_topic_created_idx" ON "chat_archive" USING btree ("topic_id","created_at");--> statement-breakpoint
CREATE INDEX "tak_bundles_recipient_idx" ON "tak_bundles" USING btree ("topic_id","recipient_user_id","recipient_device_id");