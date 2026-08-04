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

**API-key callers — two scopes apply.** The key needs `/openstoa/chat/read` in its `cmd`
(else 403), AND its `historyGrant` bounds which bundles are delivered — a bundle IS the
ability to decrypt its own `scope`, so only bundles provably no wider than the grant are
returned. `full` = all bundles, `none` = **403**. A bounded grant (`Nd` / `N` /
`since_epoch:N`) receives bundles of the SAME shape that are no wider (e.g. a `30d` key
gets `7d` and `30d` bundles, never `full`); a bundle in a different shape than the grant
is withheld, because the server cannot prove `since_epoch:N` is inside `Nd` without a
per-epoch clock. Withheld bundles are left UNACKED and are still delivered to a wider
credential. Human sessions are unaffected.

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
