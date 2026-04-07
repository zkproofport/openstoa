ALTER TABLE "chat_messages" ADD COLUMN "is_ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "is_ai" boolean DEFAULT false NOT NULL;