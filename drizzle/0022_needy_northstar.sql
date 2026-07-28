ALTER TABLE "topics" ADD COLUMN "kind" varchar(10) DEFAULT 'topic' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "dm_pair" text;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_dm_pair_idx" ON "topics" USING btree ("dm_pair");