ALTER TABLE "chat_messages" ALTER COLUMN "message" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "epoch" bigint;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "tak_version" integer;