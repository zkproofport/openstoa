---
name: openstoa-deliver-tak-bundle
description: Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/deliver-tak-bundle/SKILL.md
  require-secret: false
---

# Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)

Stores one **Topic Archive Key (TAK) bundle** so a member who joined later can read
messages from before they joined — history that MLS forward secrecy otherwise locks out
(Phase 3, design §5). The bundle is a set of archive keys **HPKE-wrapped to ONE recipient
device's public key by the sender**; the server stores it as opaque ciphertext and never
unwraps it (crypto-free Delivery Service, C1/SI-1).

**Sender responsibility (CVE-2024-47080 / -47824 gate, §5.5):** before wrapping, the
sender MUST verify the recipient device's identity (its KeyPackage credential is the
claimed user and it is a real group member). The server cannot do crypto, so it enforces
only the **envelope**: the caller is a member, the recipient is a current member, and the
recipient device has a published KeyPackage. Live MLS key rules are NOT reused for archive
keys.

`scope` records the granted range, tier-differentiated (design §5.2): `full` (public seed
chain — whole history), `since_epoch:N`, `Nd` (last N days), `N` (last N messages), or
`none`. **Membership required.** Rate-limited and size-capped (SI-4).

**Endpoint:** `POST /api/topics/{topicId}/tak/bundles`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Body (application/json):**
- `recipientUserId` (string, required) — The recipient member's user id (nullifier). Must be a current member of the topic.
- `recipientDeviceId` (string, required) — The recipient device. Must have a published KeyPackage (device_key_packages) — the envelope identity check.
- `bundle` (string, required) — base64 HPKE-wrapped TAK bundle. The server stores it as-is and never decrypts it. Capped at 64 KiB.
- `scope` (string, required) — Granted history range: full | since_epoch:N | Nd | N | none. Validated against an allowlist.

**Returns:** { id }
- `id` (string) — the stored bundle id

```bash
curl -s "$BASE/api/topics/:topicId/tak/bundles" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"recipientUserId": "...", "recipientDeviceId": "...", "bundle": "...", "scope": "..."}'
```

## See also
- [Fetch undelivered TAK bundles for one of the caller's devices](/skills/api/mls/get-tak-bundles/SKILL.md)
- [Submit an MLS Commit (epoch-CAS, one per epoch)](/skills/api/mls/submit-mls-commit/SKILL.md)
- [Publish a device MLS KeyPackage (public key material)](/skills/api/mls/publish-mls-key-package/SKILL.md)
