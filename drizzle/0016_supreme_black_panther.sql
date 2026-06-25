-- Phase 3: recipient_user_id is informational (MLS leaf credential is a device
-- id, not the user nullifier) → drop its FK. IF EXISTS so it's safe on fresh /
-- already-migrated / db:push-built databases.
ALTER TABLE "tak_bundles" DROP CONSTRAINT IF EXISTS "tak_bundles_recipient_user_id_users_id_fk";
