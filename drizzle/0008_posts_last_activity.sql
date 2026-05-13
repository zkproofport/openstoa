ALTER TABLE "posts" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now();
