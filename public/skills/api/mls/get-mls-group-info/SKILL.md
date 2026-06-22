---
name: openstoa-get-mls-group-info
description: Get the topic's public MLS GroupInfo (for External Commit)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/get-mls-group-info/SKILL.md
  require-secret: false
---

# Get the topic's public MLS GroupInfo (for External Commit)

Returns the latest **public** GroupInfo for the topic's MLS group, plus the current epoch
and ciphersuite. A device joining via **External Commit** (e.g. a new device when the old
one is offline) needs this to build its join Commit. GroupInfo is public group state — it
contains no secrets and the server never decrypts anything. Returns **404** before the
group exists or before any GroupInfo has been published. **Membership required.**

**Endpoint:** `GET /api/topics/{topicId}/mls/group-info`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Returns:** { groupInfo, epoch, ciphersuite }
- `groupInfo` (string) — base64 public GroupInfo bytes
- `epoch` (integer)
- `ciphersuite` (string)

```bash
curl -s "$BASE/api/topics/:topicId/mls/group-info" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Submit an MLS Commit (epoch-CAS, one per epoch)](/skills/api/mls/submit-mls-commit/SKILL.md)
- [Publish a device MLS KeyPackage (public key material)](/skills/api/mls/publish-mls-key-package/SKILL.md)
