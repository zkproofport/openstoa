---
name: openstoa-get-tak-bundles
description: Fetch undelivered TAK bundles for one of the caller's devices
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/get-tak-bundles/SKILL.md
  require-secret: false
---

# Fetch undelivered TAK bundles for one of the caller's devices

Returns the not-yet-acked TAK bundles addressed to the caller's `deviceId`, oldest first.
The caller can only read **its own** bundles (`recipientUserId` is the session user). This
is read-only — bundles stay pending until the device acks them with `DELETE` after durably
persisting the keys, so a crash between fetch and persist re-delivers rather than losing
history. **Membership required** (a removed member gets 403 — D11 archive gating).

**Endpoint:** `GET /api/topics/{topicId}/tak/bundles`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Query parameters:**
- `deviceId` (string, required) — The caller's device id whose pending bundles to fetch.

**Returns:** { bundles }
- `bundles` ({ id, bundle, scope, createdAt }[])

```bash
curl -s "$BASE/api/topics/:topicId/tak/bundles?deviceId=..." \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)](/skills/api/mls/deliver-tak-bundle/SKILL.md)
