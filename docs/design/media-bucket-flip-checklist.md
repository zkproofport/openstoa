# Media bucket flip checklist

Status: **gates 1 and 2 are closed on LOCAL DEV** — the 84 offending rows are deleted and
MinIO now refuses anonymous reads, both verified by running requests rather than reading
config. Nothing was run against staging or production; every staging/production command
below is written for a human with that access to run, and is marked as such.

Gates 3 and 4 are production-only by an explicit product decision and do NOT block the
staging flip — see "The edge layer is PRODUCTION-ONLY" at the bottom before re-reading
their rows as staging gaps.

Related: [`media-bucket-privatisation.md`](./media-bucket-privatisation.md) (candidate B,
adopted) and [`gated-image-credentials.md`](./gated-image-credentials.md) (why the
mini-app and the two web hosts needed fixing before the gate had anything to check) — M-6,
which both docs describe, is done and merged (`aaa0588`). This doc is the pre-flight for
the step M-6 was building toward: making the R2 bucket itself refuse anonymous reads, the
one remaining step `media-bucket-privatisation.md` said M-6 would leave.

The five sections below are independent gates — check all of them before the bucket goes
private, not just the first one someone happens to look at. "All five satisfied" is the bar
for PRODUCTION only: gates 3 and 4 are N/A on staging by decision, so staging's bar is
gates 1, 2 and 5.

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

**The query above over-matches, and the difference is a deleted post.** It matches any
absolute URL with `/topics/` or `/users/` anywhere in it — including a link to a topic
*page* in prose (`https://openstoa.xyz/topics/<uuid>`, no image involved) and a chat
attachment key (`…/topics/<uuid>/chat/…`, ciphertext read through the membership-gated
route, unaffected by the bucket's policy). Neither is an offending row, and on local dev
both queries happened to return the same 84 rows — so the looseness cost nothing here and
would have cost real posts on a corpus that contains such links. The deletion script
(below) anchors on the full object-key shape instead, requiring the folder and the UUID
segment `uploadObjectKey` actually emits:

```
<scheme>://<host>[/<bucket>]/topics/<id>/(posts|image)/<uuid>/<file>
<scheme>://<host>[/<bucket>]/users/<id>/(profile|uploads)/<uuid>/<file>
```

Verified against both: prose page links and chat-attachment keys match the loose query and
are correctly ignored by the anchored one; relative `/api/media/…` and external images
(YouTube, `placehold.co`) match neither.

**Verified this session, local dev — found, then resolved:**

| Column | Absolute-URL rows (before) | After deletion |
|---|---|---|
| `posts.content` | 54 | **0** |
| `posts.media.images[]` | 30 | **0** |
| `topics.image` | 0 | 0 |
| `users.profile_image` | 0 | 0 |

The 54 and 30 overlap: 84 distinct posts, out of 2594. All 84 pointed at the local MinIO
host (`http://10.78.14.37:9000/openstoa-dev/…`) — E2E residue, exactly as predicted below.
`scripts/delete-absolute-media-rows.ts --apply` deleted them; 2594 → 2510 posts, and a
second run deletes 0 (idempotent). Both the anchored query AND the loose one above now
return 0 on all four columns.

**Status: SATISFIED on local dev**, confirmed by re-running the query after the change, not
assumed from the script's own exit code. `topics.image` and `users.profile_image` were
already clean and were never touched.

The count grew over the life of this doc (~46/~26 partway through M-6 development, 54/30
here) for a reason worth keeping: every row written before M-6 pointed `R2_PUBLIC_URL` at
`/api/media` stays absolute forever, and each local E2E run against the old configuration
minted more. It stops growing now only because that flow is fixed — which is the point of
"Deleting the rows is not durable unless `R2_PUBLIC_URL` is relative" below, and the reason
that check has to happen on staging BEFORE the deletion rather than after.

**Staging: UNKNOWN FROM HERE.** No DB access from this session. The user has stated staging
is truncated; that is a claim to verify with the query above before the flip, not to trust
without running it — a database can accumulate rows between "truncated" and "flip day" the
same way local dev did.

**Production: UNKNOWN FROM HERE**, same caveat — "no users yet" is a point-in-time claim,
not a standing guarantee; verify at flip time, not from this document's age.

**If any row is found — delete it. `scripts/delete-absolute-media-rows.ts`.** Not
`rewrite-media-urls.ts`: see "Item 1 is resolved by DELETION" at the bottom of this doc.
That script stays in the tree for the day there is data worth keeping; today there is not.

Run it **before** removing the bucket's anonymous access, not after — doing it after means
those images are already 403ing while you work.

`db-proxy.sh` lives in the PARENT repo (`proofport-app-dev/scripts/`), not in this one; the
script lives here. Staging proxies to `127.0.0.1:15432`, production to `15433`.

```bash
# Terminal 1 — from the parent repo
./scripts/db-proxy.sh staging proxy          # production: ...production proxy

# Terminal 2 — from THIS repo (openstoa/). Password: $POSTGRES_PASSWORD
# / .env.staging, same source db-proxy.sh itself uses.
export DATABASE_URL="postgresql://proofport:${POSTGRES_PASSWORD}@127.0.0.1:15432/openstoa"

# 1. Look, don't touch. Prints per-column counts, then rolls back.
npx tsx scripts/delete-absolute-media-rows.ts

# 2. Only if the counts look right.
npx tsx scripts/delete-absolute-media-rows.ts --apply
```

`MEDIA_HOST` is optional. Omitted, the script matches our key shape on ANY host, which is
what you want when you don't know the environment's media hostname (open question #3 in
`media-bucket-privatisation.md` — staging's is still unconfirmed). Set it and only that host
matches, which additionally rules out a lookalike domain that copies our key shape. Unlike
`rewrite-media-urls.ts`, a wrong `MEDIA_HOST` cannot cause silent false confidence: the
script prints its match scope on the first line and the before/after counts either side of
the write, so "0 rows" is always attributable.

What it does, per column — the two are not the same action:
- `posts.content` / `posts.media.images[]` → **DELETE the post row.** The image *is* the
  content. `comments` and `records` have `NO ACTION` foreign keys onto `posts` and are
  removed first in the same transaction, or the delete aborts on them.
- `topics.image` / `users.profile_image` → **`SET NULL`.** Deleting the topic row would
  cascade into its posts, members, and chat history; deleting the user row would take the
  account and everything it authored. Neither is proportionate to a stale cover photo or
  avatar, so the offending *value* goes and the row stays. Still deletion, not a backfill —
  nothing is rewritten into a working URL anywhere in this script. Wanting those rows gone
  outright is a call for a human to make explicitly.

The whole run is one transaction, and the objects themselves are left in the bucket:
post-flip nothing can reach an object no row references, and reclaiming the bytes is the
unclaimed-media sweep's job.

### Deleting the rows is not durable unless `R2_PUBLIC_URL` is relative — CHECK THIS FIRST

Gate 1 as written measures a *stock* (rows holding absolute URLs) and says nothing about
the *flow* that produces them. `uploadToR2` mints every new URL as
`${config.R2_PUBLIC_URL}/${key}` (`src/lib/r2.ts:274`), so if the environment's
`R2_PUBLIC_URL` is still an absolute media host, the cleanup is a point-in-time snapshot:
every upload after it re-creates exactly the rows just deleted, and they break the moment
the bucket goes private. That is how local dev accumulated 84 of them.

Locally this is settled — `scripts/dev.sh` exports `R2_PUBLIC_URL=/api/media`. **Staging and
production are not verifiable from here**: the value is the GitHub secret
`STAGING_R2_PUBLIC_URL[_NEW]` / `PRODUCTION_R2_PUBLIC_URL[_NEW]`, injected at deploy
(`.github/workflows/deploy.yml:270`), and no session without repo-secret access can read it.
It is also the same open question #3 (`media-bucket-privatisation.md`) that has been unresolved
since the original research.

Confirm it is relative BEFORE running the deletion, or the deletion buys nothing:

```bash
gcloud run services describe proofport-community-staging --region us-central1 \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep R2_PUBLIC_URL
```

Wanted: `/api/media`. If it is still `https://media.zkproofport.app` (or any absolute host),
update the GitHub secret and redeploy first — then delete the rows, then flip the bucket.
Order matters and this is the step that is easiest to skip.

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

**Now closed.** `docker-compose.yml`'s `minio-init` no longer grants anonymous read by
default — the grant became a lever:

```yaml
mc anonymous set ${OPENSTOA_DEV_BUCKET_ANONYMOUS:-none} local/${R2_BUCKET_NAME}
```

`scripts/dev.sh` exports the default (`none`) and prints which state the bucket is in, so
a stack that is bypassable says so rather than looking identical to one that isn't. Setting
`OPENSTOA_DEV_BUCKET_ANONYMOUS=download` restores the old public behavior for one run —
the local rollback lever, and the way to reproduce the pre-flip bypass on purpose. This is
safe to default on only because item 1 is now closed; while those 84 rows existed, flipping
this would have broken every one of them.

**Status: SATISFIED on local dev — verified by request, not by reading the config.** Both
the policy AND real HTTP fetches were checked, before and after:

| Probe | Before flip | After flip |
|---|---|---|
| anonymous, DIRECT to MinIO (`:9000/<bucket>/<key>`) | `200` — the bypass | **`403` `AccessDenied`** |
| anonymous, through the gate, private object | `401` | `401` |
| **authenticated**, through the gate, private object | `200` | **`200`** |
| anonymous, through the gate, public-topic image | `200` | **`200`** |

`scripts/verify-media-bucket-flip.sh` runs exactly that table, and is the thing to re-run
after any change here. The object under test is uploaded through the real `POST /api/upload`
during the run, so it is a genuinely gated `users/<id>/uploads/…` key, not a hand-picked
fixture. The probe discriminates: flipped back to `download` it reports `200` on the first
row and `403` again once returned to `none`, so a pass means the policy is actually doing
the work rather than the test being unable to fail. The last two
rows are the ones that make this a flip rather than an outage: the app still reads the
bucket with credentials (`R2_ENDPOINT`), so authenticated reads and guest reads of public
content both keep working — only the unauthenticated *direct* path died. `Cache-Control:
public, max-age=31536000, immutable` is still set on the public object, unchanged.

Upload itself was exercised after the flip too (that is how the probe object got there), so
the credentialed write path is confirmed unaffected.

**Rollback (local):** `OPENSTOA_DEV_BUCKET_ANONYMOUS=download ./scripts/dev.sh`, or against
a running stack, `docker exec proofport-minio mc anonymous set download local/<bucket>` —
same command, forward direction. Effectively instant; a same-host container ACL flip, no
propagation delay.

### The real R2 equivalent — NOT run from here

An R2 bucket has **two independent** public-read surfaces, and closing one does not close
the other. Find out which are on before flipping anything — staging's is genuinely unknown
(open question #3 in `media-bucket-privatisation.md` never got resolved):

```bash
# Staging bucket is `openstoa-stg`; production is `openstoa-prod`
# (docs/migration/cloudflare-setup.md §4). Both on the corp Cloudflare account.
npx wrangler r2 bucket dev-url get openstoa-stg     # the r2.dev subdomain
npx wrangler r2 bucket domain list openstoa-stg     # any custom domains
```

Then disable whichever came back enabled:

```bash
# 1. the r2.dev public development URL
npx wrangler r2 bucket dev-url disable openstoa-stg

# 2. any custom domain (production is media.zkproofport.app; staging's is unconfirmed
#    — take it from `domain list` above, do not assume)
npx wrangler r2 bucket domain remove openstoa-stg --domain <domain from the list>
```

Production is the same two commands against `openstoa-prod` — but the production flip is
separately blocked on #83 → #81/M-7 (see items 3/4), so it is not simply "run these now".

Both commands accept `--force`/`-y` to skip the confirmation prompt; do not use it — the prompt
names the bucket it is about to change. Removing a custom domain **also deletes the CNAME
record it created**, so rollback (`wrangler r2 bucket domain add <bucket> --domain <d>
--zone-id <z>`) recreates a DNS record and is not instant the way the local MinIO toggle is
— see item 5.

Verifying the R2 flip is the same shape as the local proof above, and must be done the same
way — a request, not a config read:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<media-host>/<a real object key>   # want 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <token>" https://<app-host>/api/media/<same key>        # want 200
```

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

This is the EDGE rate limit, and it is #81/M-7 — noted as a dependency here, not duplicated.

**Correction to an earlier draft of this doc**, which said "no rate-limit code exists on
`/api/media` today (verified by grep)". That was true when written and is now false:
`722436e` ("feat(media): cap how fast one caller can pull images") added
`src/lib/mediaRateLimit.ts`, and the route calls it —
`checkMediaReadRateLimit(identity)` → 429 with `Retry-After`
(`src/app/api/media/[...key]/route.ts:236`). So the APPLICATION-level cap now exists; what
remains for #81 is the edge-level one, in front of the origin, which is a different layer
solving a different half of the problem (an edge limit spares the origin the request
entirely; the in-app limit still costs a Cloud Run invocation to answer 429).

Item 4's staging/production verdicts below are unchanged by this — staging is N/A by the
product decision, and production is blocked on #83 → #81/M-7 regardless.

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
| 1 | No absolute media URLs stored | **Satisfied** — 54 + 30 found (84 posts), deleted, re-query returns 0 | Unknown from here — run the script's dry run | Unknown from here — run the script's dry run |
| 2 | Storage layer itself denies anonymous reads | **Satisfied** — MinIO now `private` by default; anonymous direct fetch 200 → 403, gate still 200, verified live | Not done — run the wrangler commands in item 2 | Not done, and blocked on 3/4 anyway |
| 3 | CDN cache exists, public cacheable, private never cached | **N/A** — no Cloudflare in front of localhost | **N/A by decision** — edge layer is production-only (see note below) | Unsatisfied — blocked on #83 -> #81/M-7 |
| 4 | Rate limit in front of `/api/media` | In-app cap **exists** (`722436e`); edge cap N/A — no edge in front of localhost | **N/A by decision** — edge layer is production-only (see note below) | Unsatisfied — blocked on #83 -> #81/M-7 |
| 5 | Rollback path known and its cost is understood | **Documented above** — cheap, not instant for real R2 | Same mechanism, unverified access to actually exercise it from here | Same mechanism, unverified access to actually exercise it from here |

### The edge layer is PRODUCTION-ONLY, by an explicit product decision

Items 3 and 4 are **not** staging gaps waiting to be filled — staging deliberately runs
without a CDN cache rule and without a rate limit, because staging carries no real traffic
and the edge layer costs money at both Cloudflare and the load balancer. Putting the GCLB
in front of production is precisely what makes it possible to attach these there and only
there.

Read the table accordingly: **staging's bucket flip does not wait on 3 or 4.** Only the
production flip is blocked, on #83 (production GCLB) -> #81/M-7 (CDN). Do not re-report
staging as "unsatisfied" on these two rows; that reading has cost the project the same
conversation more than once.

### Item 1 is resolved by DELETION, not a rewrite

OpenStoa has not launched. There is no user data to preserve, so the 54 + 30 rows holding
absolute media URLs are simply deleted rather than migrated — a rewrite pass would be
effort spent protecting rows nobody will miss. The same applies to any other pre-launch
data shape this checklist finds wanting.

**Done, as of this session**: `scripts/delete-absolute-media-rows.ts`. Applied to local dev
(84 posts deleted, all four columns now 0). Staging and production have NOT been touched —
run its dry run there first, per item 1. `scripts/rewrite-media-urls.ts` is untouched and
stays in the tree for the day there is data worth keeping; do not reach for it now.
