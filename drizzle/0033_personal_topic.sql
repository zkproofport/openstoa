-- The owner's own space: an ordinary secret topic that nobody else can enter.
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "personal" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- One per account, enforced here rather than in application code: two sign-ins
-- racing is ordinary, and a check-then-insert would split an account's posts
-- across two spaces with nothing to tell the person which one they were in.
CREATE UNIQUE INDEX IF NOT EXISTS "topics_personal_owner_idx"
  ON "topics" ("creator_id") WHERE "personal";
