---
name: openstoa-set-archive-root-fingerprint
description: Publish the archive root's identity (compare-and-set, first writer wins)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/set-archive-root-fingerprint/SKILL.md
  require-secret: false
---

# Publish the archive root's identity (compare-and-set, first writer wins)

Publishes `base64(HKDF(root, "openstoa-archive-root-id/v1", 16))` for a public topic.
**COMPARE-AND-SET: the value is only ever written over null, never over an existing one.**
If another device published first, the response returns THAT fingerprint with
`claimed: false` — the caller must then adopt the winner's root (request it via
`GET /api/topics/{topicId}/tak/bundles`) and must NOT keep archiving under its own, or it
writes rows no one can decrypt. Re-publishing the same value you already published is
idempotent (`claimed: true`).

**Call this only when you can prove your root is the topic's real one:**
- `archiveCount == 0` (from GET) → nothing to contradict you; publish immediately after
 generating the root and BEFORE archiving anything under it.
- `archiveCount > 0` with a null fingerprint → publish only if your root successfully decrypts
 the OLDEST existing archive row. A root that cannot is an orphan and must stay unpublished.

The server cannot check any of this (C1: it holds no key material and performs no crypto) —
it enforces only the envelope: public topic, current member, well-formed 16-byte value, and
write-once. Public topics only. **Membership required.** Rate-limited.

**Endpoint:** `PUT /api/topics/{topicId}/tak/root-fingerprint`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Body (application/json):**
- `fingerprint` (string, required) — base64 of exactly 16 bytes — HKDF(root, "openstoa-archive-root-id/v1", 16). Never send the root itself.

**Returns:** { fingerprint, claimed }
- `fingerprint` (string) — The value now stored for the topic.
- `claimed` (boolean) — true if your value is the stored one. false means another device won — adopt its root.

```bash
curl -s "$BASE/api/topics/:topicId/tak/root-fingerprint" \
  -H "Authorization: Bearer $TOKEN" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d '{"fingerprint": "..."}'
```

## See also
- [Read which archive root a public topic's history is sealed under](/skills/api/mls/get-archive-root-fingerprint/SKILL.md)
- [Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)](/skills/api/mls/deliver-tak-bundle/SKILL.md)
- [Fetch undelivered TAK bundles for one of the caller's devices](/skills/api/mls/get-tak-bundles/SKILL.md)
