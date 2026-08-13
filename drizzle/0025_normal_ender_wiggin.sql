CREATE TABLE "topic_archive_roots" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"root_key" text NOT NULL,
	"deposited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "topic_archive_roots" ADD CONSTRAINT "topic_archive_roots_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_archive_roots" ADD CONSTRAINT "topic_archive_roots_deposited_by_users_id_fk" FOREIGN KEY ("deposited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;