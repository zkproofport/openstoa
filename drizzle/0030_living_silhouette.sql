CREATE TABLE "chat_reads" (
	"topic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_message_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_reads_topic_id_user_id_pk" PRIMARY KEY("topic_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_reads_user_idx" ON "chat_reads" USING btree ("user_id");