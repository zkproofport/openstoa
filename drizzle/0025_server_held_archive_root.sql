-- Server-held archive root for PUBLIC topics only.
--
-- A public topic can be joined by anyone, so its chat history is not secret
-- from the public — only from the operator. Paying for that with "history is
-- unreadable unless another member happens to be online AND has this chat room
-- open" is a bad trade, and it is exactly the failure that was reported: with
-- every holder offline, a new member's history never arrived at all.
--
-- Nothing about how a message is stored changes. The archive stays sealed
-- exactly as before; what changes is that a copy of the key lives here, so a
-- member who joins later reads history immediately.
--
-- private, secret and DM are NOT here. Their root stays on members' devices,
-- which is what keeps "the server cannot read this" true where the product
-- claims it. Those tiers accept the documented limit (design SI-6/SI-6b): if
-- every holder is gone, their archive is unreadable.
--
-- Separate table rather than a column on `topics` so the key can be granted,
-- audited and — if a topic is ever made private — deleted on its own.
CREATE TABLE IF NOT EXISTS "topic_archive_roots" (
  "topic_id" uuid PRIMARY KEY REFERENCES "topics"("id") ON DELETE CASCADE,
  -- The archive root itself, base64. Public topics only; the row simply does
  -- not exist for any other tier.
  "root_key" text NOT NULL,
  -- Which client deposited it, for audit. Not used for authorisation.
  "deposited_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now()
);
