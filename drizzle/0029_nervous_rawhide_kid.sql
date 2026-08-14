CREATE TABLE "mls_device_joins" (
	"topic_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"leaf_identity" text,
	"user_id" text,
	"joined_epoch" bigint NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mls_device_joins_topic_id_device_id_pk" PRIMARY KEY("topic_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "mls_device_joins" ADD CONSTRAINT "mls_device_joins_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mls_device_joins_topic_idx" ON "mls_device_joins" USING btree ("topic_id");