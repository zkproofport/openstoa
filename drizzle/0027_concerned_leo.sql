CREATE TABLE "chat_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"uploader_id" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chat_media" ADD CONSTRAINT "chat_media_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_media" ADD CONSTRAINT "chat_media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_media_object_key_idx" ON "chat_media" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "chat_media_topic_created_idx" ON "chat_media" USING btree ("topic_id","created_at");