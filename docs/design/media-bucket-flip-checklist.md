# Media bucket flip checklist

Status: documentation and verification only. No infrastructure changed, nothing flipped.
Every command below was either run read-only against local dev, or is given for someone
with staging/production access to run — clearly marked which is which.

Related: [`media-bucket-privatisation.md`](./media-bucket-privatisation.md) (candidate B,
adopted) and [`gated-image-credentials.md`](./gated-image-credentials.md) (why the
mini-app and the two web hosts needed fixing before the gate had anything to check) — M-6,
which both docs describe, is done and merged (`aaa0588`). This doc is the pre-flight for
the step M-6 was building toward: making the R2 bucket itself refuse anonymous reads, the
one remaining step `media-bucket-privatisation.md` said M-6 would leave.

The five sections below are independent gates — all five should read "satisfied" before
the bucket goes private, not just the first one someone happens to check.

## 1. Stored URLs

**What must be true.** No row in `posts.content` (inline `<img src>`), `posts.media.images[]`,
`topics.image`, or `users.profile_image` may hold an ABSOLUTE URL that points at the media
host itself (`media.zkproofport.app/...`, or the local MinIO host). A relative
`/api/media/...` value is fine and expected — it's served by the app, unaffected by the
bucket's own access policy. An absolute value pointing anywhere else (YouTube thumbnails,
`placehold.co` test fixtures, any real external link) is also fine — this check is
specifically for URLs shaped like our own object keys under our own (former) media host.

**What breaks if it isn't true.** The row itself is undamaged — this is a display failure,
not data loss, and the underlying object usually still exists in R2, just no longer
reachable at that literal URL. The moment the bucket stops serving anonymous reads, every
browser/mobile client hitting that literal absolute URL gets a failed image load. Concretely
this is very likely a **403 (AccessDenied)**, not a 404 — S3-compatible servers return 403
when the object exists but the caller isn't authorized, and 404 only when the key itself is
gone. That distinction matters for triage after a flip: a 403 spike on the media host means
exactly this (old absolute rows); a 404 spike means something else (a key genuinely missing,
or a shape neither `uploadObjectKey` nor `parseMediaObjectKey` recognizes).

**How to check — the query, anchored so it doesn't false-positive on prose that merely
mentions the domain** (mirrors the anchoring `scripts/rewrite-media-urls.ts` already uses,
`/topics/` or `/users/` immediately after the host):

```sql
SELECT 'posts.content' AS col, count(*) FROM posts
  WHERE content ~ '(https?://[^"]*)(/topics/|/users/)'
UNION ALL
SELECT 'posts.media', count(*) FROM posts
  WHERE media::text ~ '(https?://[^"]*)(/topics/|/users/)'
UNION ALL
SELECT 'topics.image', count(*) FROM topics
  WHERE image ~ '^https?://.*(/topics/|/users/)'
UNION ALL
SELECT 'users.profile_image', count(*) FROM users
  WHERE profile_image ~ '^https?://.*(/topics/|/users/)';
```

Run it with `docker exec proofport-postgres psql -U proofport -d openstoa -t -c "..."` for
local dev. For staging/production, per `.claude/agents/openstoa-dev.md`'s documented access
path: `./scripts/db-proxy.sh staging proxy` (or `production proxy`) in one terminal, then
`./scripts/db-proxy.sh staging psql` (or `production psql`) in another, and run the same
query there. **Do not infer staging/production state from this doc or from anyone's
recollection — run the query.**

**Verified right now, local dev (this session, read-only):**

| Column | Absolute-URL rows | Out of |
|---|---|---|
| `posts.content` | 54 | 1971 posts |
| `posts.media.images[]` | 30 | 1971 posts |
| `topics.image` | 0 | 1524 topics |
| `users.profile_image` | 0 | 2457 users |

**Status: UNSATISFIED on local dev**, confirmed by query, not assumed — real rows from
E2E runs against local MinIO before and during M-6 development. `topics.image` and
`users.profile_image` are clean. This is a strictly larger count than the ~46/~26 reported
partway through M-6 development — more E2E runs have happened since, and it will keep
growing every time the local suite runs against local MinIO, because these are absolute
URLs by construction (local MinIO's `R2_PUBLIC_URL` was absolute until the M-6 `dev.sh`
change, and every row written before that change stays absolute forever — see item 2, this
is a *separate* fact from whether NEW rows are relative). Also: `posts.media` and
`posts.content` already show real relative-URL adoption post-M-6 — 9 and 38 rows
respectively contain `/api/media/` — so local dev is genuinely in the mixed state M-6's
`absolutizeMediaUrl` graceful-degradation was built for, not a hypothetical.

**Staging: UNKNOWN FROM HERE.** No DB access from this session. The user has stated staging
is truncated; that is a claim to verify with the query above before the flip, not to trust
without running it — a database can accumulate rows between "truncated" and "flip day" the
same way local dev did.

**Production: UNKNOWN FROM HERE**, same caveat — "no users yet" is a point-in-time claim,
not a standing guarantee; verify at flip time, not from this document's age.

If any row is found: `scripts/rewrite-media-urls.ts` exists for exactly this (see
`media-bucket-privatisation.md`'s Plan A section for its safety properties and the ordering
constraint — run it, or otherwise handle the rows, **before** the bucket goes private, not
after; doing it after means the objects are already 403ing while you fix the rows).

## 2. MinIO's own anonymous-read policy (local dev only — no R2/production analog)

**What must be true**, if anyone wants local dev to actually rehearse the flip rather than
just look similar to it: MinIO's bucket-level anonymous access must ALSO be removed. M-6
made `R2_PUBLIC_URL=/api/media` locally (`scripts/dev.sh`), so the APP no longer *hands out*
a direct MinIO URL for new uploads — but MinIO itself was never told to stop *answering*
anonymous requests, and nothing in M-6 touched that. Two separate switches; M-6 flipped one.

**How to check, and what I found — verified live, right now:**

```bash
docker exec proofport-minio sh -c \
  "mc alias set local http://localhost:9000 <access-key> <secret-key>; mc anonymous get local/<bucket>"
```

Returned: `Access permission for `local/openstoa-dev` is `download`` — still fully public.
Confirmed a second way, bypassing the app and its M-5 gate entirely:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:9000/openstoa-dev/<any real object key>"
```

Returned `200` for a real key pulled from the local DB, anonymous, no session, no
`Authorization` header — the exact bearer-URL bypass M-5 was built to close, still fully
open at the storage layer locally.

**Status: UNSATISFIED, confirmed live.** This is expected and not itself a problem — see
below — but it means **"it works on my machine" proves nothing about whether the actual
flip works**, because local dev's storage layer has never been gated to begin with,
independent of anything M-5 or M-6 did at the app layer. Testing the real flip locally
would need, additionally: `mc anonymous set none local/<bucket>` — the same command
`docker-compose.yml`'s `minio-init` service already uses to grant it
(`mc anonymous set download local/${R2_BUCKET_NAME}`, `docker-compose.yml:109`), reversed.
**Not run here** — that's an infrastructure change, out of scope for this doc, and it would
also break every one of the absolute-URL rows in item 1 immediately for local dev, which
nobody has cleaned up yet.

**Rollback (local):** `mc anonymous set download local/<bucket>` — same command, forward
direction. Effectively instant; it's a same-host container ACL flip, no propagation delay.

## 3. A CDN cache in front of `/api/media`

**What must be true.** `/api/media/*` responses for genuinely-public objects need to be
served from Cloudflare's edge cache on repeat requests, not from Cloud Run every time.
Today (public bucket), a browser loading the same avatar twice hits R2 directly and R2's
egress is free; once the bucket is private and every load goes through `/api/media`, an
uncached setup makes every single image view a Cloud Run request — Cloud Run egress and
compute are billed, so this is the thing that makes R2's cost advantage disappear if
skipped, not just a latency nicety.

**Current state — verified by reading the actual corp migration doc, not assumed:**
`docs/migration/cloudflare-setup.md` §5-3 ("Page Rules / Cache Rules") lists exactly two
items, both marked optional (`(선택)`) and both **unchecked**:

```
- [ ] (선택) `*.zkproofport.app/api/*` → Cache Level: Bypass
- [ ] OpenStoa 정적 자산만 캐싱
```

Neither is applied. **Status: task #81/M-7 has not started at the Cloudflare config
layer** — confirmed by reading the checklist state, not inferred from the todo tracker
alone. Today, `/api/media` relies entirely on Cloudflare's *default* cache behavior, which
— per the citation already in `media-bucket-privatisation.md`'s Sources — generally does
not cache API-shaped paths without an explicit Cache Rule.

**A real conflict to flag for whoever builds #81, found by reading both docs together**:
the one *documented* (optional, unapplied) rule above would **bypass all of `/api/*`** —
if it's ever applied literally as written, it would also bypass `/api/media`, the opposite
of what #81 needs. Cloudflare evaluates Cache Rules in priority order, so `/api/media`
needs either its own higher-priority rule or an explicit carve-out from the blanket
`/api/*` bypass — not a detail to discover after both rules are live and disagreeing.

**How to check a cache is actually being served by the edge, not the origin:**

```bash
curl -sI https://<app-host>/api/media/<a genuinely public key> | grep -i cf-cache-status
```

Request it twice. First request from a cold edge node is typically `MISS` or `EXPIRED`;
the second (from the same edge PoP) should show `HIT`. `DYNAMIC` or `BYPASS` on both means
nothing is being cached at all — the state #81 needs to fix.

**The check that must not be got wrong — private objects must NEVER show `HIT`:**

```bash
curl -sI https://<app-host>/api/media/<a secret-topic or private-topic key> | grep -i cf-cache-status
```

Run this **twice**, ideally from two different sessions/identities if the gate's `HIT`
would be shared regardless of who asks (a shared cache HIT ignores who's asking — that's
the entire risk). Expect `DYNAMIC`/`BYPASS`/header absent on **every** request, never `HIT`.
The M-5 route already sets `Cache-Control: private` for exactly these objects
(`src/app/api/media/[...key]/route.ts`), and Cloudflare's documented default honors that —
but a Cache Rule can override it (an "Eligible for cache: All" + "Edge TTL: Override
origin" rule ignores the origin's own `Cache-Control` header entirely). **This has to be
re-verified against whatever Cache Rule #81 actually ships**, not assumed safe because the
default was safe before a rule existed.

**Status: UNKNOWN FROM HERE for live edge behavior** (no Cloudflare in front of
`localhost` — this cannot be exercised from local dev at all, by construction). **VERIFIED
FROM READING that no rule exists yet** — which makes the "private is never cached" property
trivially true today (nothing is cached, so nothing can leak) and the "public is cached"
property false (task not started). Both need re-checking once #81 ships a real rule —
passing the first check the day the rule is deployed does not mean it stays true after the
next edit to that rule.

## 4. Rate limiting

This is also #81/M-7 — noted as a dependency here, not duplicated. **No rate-limit code
exists on `/api/media` today** (`grep -n "checkRateLimit\|RateLimit"
src/app/api/media/\[...key\]/route.ts` → no matches, verified this session). The existing
pattern to extend, already used elsewhere in this codebase for exactly this shape of
problem: `RateLimit` / `checkRateLimit` in `src/lib/mls/http.ts` (e.g.
`MLS_RATE_KEY_PACKAGE`, `MLS_RATE_COMMIT`) — a per-key, per-window counter, not a new
mechanism to invent.

**What breaks without it, once private:** every image load that isn't an edge-cache `HIT`
(item 3) reaches the app and runs the M-5 gate's DB query (topic visibility / membership
lookup) on every single request. A popular public post today costs R2/MinIO nothing extra
per viewer; post-flip, without both a cache AND a floor on request rate, the same traffic
pattern becomes Cloud Run request volume and DB query volume that scales directly with
viewers × images-per-view, uncapped — a cost and availability risk this app has never had
to absorb on this path before.

## 5. Rollback

**Local (MinIO):** `mc anonymous set download local/<bucket>` — reverses the exact grant
`docker-compose.yml`'s `minio-init` already issues. Effectively instant (same-host
container ACL change, no propagation).

**Real (staging/production R2):** per `media-bucket-privatisation.md`'s Plan A research,
production's public access is bound through a Cloudflare R2 **Custom Domain**
(`media.zkproofport.app`, `docs/migration/cloudflare-setup.md` §4). "The flip" is
disconnecting that custom domain; per the R2 docs already cited there, disconnecting also
removes the CNAME record it created. **Rollback is reconnecting it** — a dashboard/API
action, not a redeploy or a rebuild, so it's cheap in the sense that matters (no code path,
no container state) — but it recreates a DNS record, so it is not instant the way the local
MinIO toggle is; expect low-single-digit minutes for Cloudflare's own edge to pick it up,
and longer for any external resolver that already cached an NXDOMAIN or stale answer for
the interval it was down.

**Say it plainly, as asked:** yes, the rollback for both is "re-enable public access on the
bucket." That is genuinely cheap and fast, which is a real argument for being willing to
attempt the flip rather than treating it as a one-way door — but it is **not a neutral
no-op**: rollback is a full re-exposure of every currently-private object (every
private/secret-topic image, every unpublished draft) until the next attempt, for however
long the rollback window lasts. It restores exactly item 1's problem — every already-stored
absolute URL starts resolving again — which is fine if item 1 was never satisfied yet
(nothing lost), and is moot for any row that was already migrated to relative (those never
depended on bucket access either way, flip or no flip).

## Summary — satisfied / unsatisfied / unknown, as of this session

| # | Item | Local dev | Staging | Production |
|---|---|---|---|---|
| 1 | No absolute media URLs stored | **Unsatisfied** — 54 + 30 rows, verified by query | Unknown from here — run the query | Unknown from here — run the query |
| 2 | Storage layer itself denies anonymous reads | **Unsatisfied** — MinIO confirmed still public, verified live | N/A locally; real-R2 equivalent is the flip itself | N/A locally; real-R2 equivalent is the flip itself |
| 3 | CDN cache exists, public cacheable, private never cached | **N/A** — no Cloudflare in front of localhost | Unsatisfied — verified by reading `cloudflare-setup.md`, rule not applied | Unsatisfied — same doc, same rule, not applied |
| 4 | Rate limit in front of `/api/media` | **Unsatisfied** — verified by grep, no code | Unsatisfied — same code, not deployed | Unsatisfied — same code, not deployed |
| 5 | Rollback path known and its cost is understood | **Documented above** — cheap, not instant for real R2 | Same mechanism, unverified access to actually exercise it from here | Same mechanism, unverified access to actually exercise it from here |

None of the five is satisfied everywhere today. Items 1 and 2 are independently fixable now
(a rewrite pass + a storage-policy check) without waiting on #81; items 3 and 4 are blocked
on #81/M-7 shipping; item 5 just needs to be read and understood once, not built.
