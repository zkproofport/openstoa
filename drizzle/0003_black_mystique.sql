ALTER TABLE "topics" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "blinded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "blinded_by" varchar(10);