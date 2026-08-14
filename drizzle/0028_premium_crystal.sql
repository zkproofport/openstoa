CREATE TABLE "chat_delivery_cursors" (
	"topic_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"delivered_through" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_delivery_cursors_topic_id_device_id_pk" PRIMARY KEY("topic_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "chat_delivery_cursors" ADD CONSTRAINT "chat_delivery_cursors_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_delivery_cursors" ADD CONSTRAINT "chat_delivery_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_delivery_topic_idx" ON "chat_delivery_cursors" USING btree ("topic_id");