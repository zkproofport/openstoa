CREATE TABLE "mls_commits" (
	"topic_id" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	"commit" "bytea" NOT NULL,
	"welcome" "bytea",
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "mls_commits_topic_id_epoch_pk" PRIMARY KEY("topic_id","epoch")
);
--> statement-breakpoint
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mls_commits_topic_epoch_idx" ON "mls_commits" USING btree ("topic_id","epoch");