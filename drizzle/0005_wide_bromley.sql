CREATE TABLE "community_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"message" text NOT NULL,
	"type" varchar(10) DEFAULT 'message' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD CONSTRAINT "community_chat_messages_topic_id_community_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."community_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_chat_messages" ADD CONSTRAINT "community_chat_messages_user_id_community_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_chat_msg_topic_idx" ON "community_chat_messages" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "community_chat_msg_topic_created_idx" ON "community_chat_messages" USING btree ("topic_id","created_at");--> statement-breakpoint
ALTER TABLE "community_posts" DROP COLUMN "media";