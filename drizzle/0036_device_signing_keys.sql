-- The signing key that proves an install is the same one as last time.
--
-- Distinct from `device_key_packages`, which holds MLS KeyPackages: those are
-- consumed on use, one per join, and say nothing about continuity. This is one
-- long-lived Ed25519 public key per device, and the private half never leaves
-- the phone.
--
-- WHY. `device_id` was a random string the client made up and sent in a header;
-- the server stored it and believed it, having nothing else to go on. Lose the
-- string and the phone becomes a stranger to itself — staging held one account
-- on one phone with 48 distinct ids across epochs 1 to 58 in a single room, each
-- one a leaf that left the epochs before it unreadable to its successor. Learn
-- the string and anyone can claim to be that device, from anywhere.
--
-- A name can be lost and a name can be copied. Holding a private key is neither.
CREATE TABLE IF NOT EXISTS "device_signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "device_id" text NOT NULL,
  "public_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "last_proved_at" timestamp with time zone
);
--> statement-breakpoint
-- One key per (account, device).
--
-- A device that re-registers is either presenting the same key — a no-op — or is
-- a genuinely new install that lost its private half. The second case has to be
-- visible rather than silently appended, because appending is precisely how one
-- phone became forty-eight rows in `mls_device_joins`.
CREATE UNIQUE INDEX IF NOT EXISTS "device_signing_user_device_idx"
  ON "device_signing_keys" ("user_id", "device_id");
