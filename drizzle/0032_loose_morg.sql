CREATE TABLE "key_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"requester_user_id" text NOT NULL,
	"requester_device_id" text NOT NULL,
	"have_from_epoch" integer,
	"granted_at" timestamp with time zone,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "key_requests" ADD CONSTRAINT "key_requests_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_requests_topic_idx" ON "key_requests" USING btree ("topic_id","granted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "key_requests_one_open_idx" ON "key_requests" USING btree ("topic_id","requester_device_id");