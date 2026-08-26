-- The space every account was supposed to have, for the accounts made before
-- there was one.
--
-- 0033 added the column and the unique index. It did not create a row for
-- anybody: `ensurePersonalTopic` runs at sign-in, and until this week
-- `ensureUser` returned early for an account it already knew, so an account
-- created before 0033 never reached it. Two comments in the source said the
-- space "will be made on their next sign-in"; for those accounts it never was.
--
-- The application fix makes that promise true from now on, but only on the next
-- sign-in. Someone already signed in — the ordinary case, since a session
-- outlives an app update — would keep an account with no space until their
-- token expired. This closes it for everyone at once, at boot, and then never
-- runs again.
--
-- Deliberately NOT a check inside a request path: the condition is transient
-- (it ends when the last pre-0033 account is fixed) and paying for it on every
-- sign-in forever would outlive the problem by years.

-- The topic itself. `gen_random_uuid()` matches the column default and is
-- built in since Postgres 13; `gen_random_bytes` is NOT — it lives in pgcrypto,
-- which this database does not have, and requiring an extension to run a
-- backfill would make the migration fail on exactly the deployments that need
-- it. The invite code is derived from a fresh uuid instead: 16 hex characters,
-- the same length the application's `randomBytes(8).toString('hex')` produces.
--
-- No invite can ever be made from a personal topic, but the column is NOT NULL
-- and unique, so a constant would collide on the second row.
INSERT INTO "topics" (
  "id", "title", "description", "creator_id", "invite_code",
  "visibility", "kind", "personal"
)
SELECT
  gen_random_uuid(),
  'My space',
  NULL,
  u."id",
  substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  'secret',
  'topic',
  true
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "topics" t
  WHERE t."creator_id" = u."id" AND t."personal"
);
--> statement-breakpoint
-- Membership, or the owner cannot open their own room: every read goes through
-- `topic_members`, and a topic whose creator is not a member is invisible to
-- the person it belongs to. Written as its own statement over the same
-- condition rather than as part of the insert above, so a half-applied run —
-- topics in, members not — is repaired by simply running this again.
INSERT INTO "topic_members" ("topic_id", "user_id", "role")
SELECT t."id", t."creator_id", 'owner'
FROM "topics" t
WHERE t."personal"
  AND NOT EXISTS (
    SELECT 1 FROM "topic_members" m
    WHERE m."topic_id" = t."id" AND m."user_id" = t."creator_id"
  );
