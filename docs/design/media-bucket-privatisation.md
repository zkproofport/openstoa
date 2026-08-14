# Making the R2 media bucket private: Plan A (rewrite URLs) vs Plan B (proxy the hostname)

Status: research only, no decision made, no infrastructure or database changes performed.

Follow-up: [`gated-image-credentials.md`](./gated-image-credentials.md) — even once the
bucket is private, `GET /api/media/{key}`'s session-based gate has no credential to check
on two real surfaces (the mini-app's cookie-less client, and the second of the two live
web hosts) until that's separately fixed. That doc builds directly on the host-only-cookie
fact established below.

## The problem

`GET /api/media/{key}` (`src/app/api/media/[...key]/route.ts`, M-5) now gates reads of
post images, topic covers, and avatars by topic visibility / ownership. That gate is
useless while the R2 bucket itself is still publicly readable: every object also answers
directly at `${R2_PUBLIC_URL}/${key}`, which today is `https://media.zkproofport.app/<key>`
— an unauthenticated bearer URL that bypasses the new route entirely. Confirmed values:

- Production `R2_PUBLIC_URL` = `https://media.zkproofport.app` (used verbatim as the
  script's own worked example, and as the literal `OLD` constant in
  `src/__tests__/rewriteMediaUrls.test.ts:23`).
- `media.zkproofport.app` is a Cloudflare R2 **bucket custom domain** — connected via
  "Custom domain 연결: `media.zkproofport.app`" in `docs/migration/cloudflare-setup.md` §4,
  bucket `masselabs-zkproofport-media` (soon-to-be `openstoa-prod` per the same doc), zone
  `zkproofport.app` on the corporate Cloudflare account.
- Every already-stored image reference points at that domain in four places:
  `posts.content` (inline `<img src>`, confirmed HTML per the `editPost` JSDoc in
  `src/app/api/posts/[postId]/route.ts`: *"`content` is HTML with the same image-embed
  rules... embed `<img src=\"$publicUrl\">`"*), `posts.media.images[]`, `topics.image`,
  `users.profile_image`.
- The user has confirmed the media domain (`media.zkproofport.app`) will **not** change
  during the Masse Labs corp migration — this is the fact that makes Plan B viable at all.

Two ways to close the gap:

- **Plan A** (what the M-5 branch built): point `R2_PUBLIC_URL` at
  `https://<app-host>/api/media`, remove the bucket's public-access binding, and run
  `scripts/rewrite-media-urls.ts --apply` once per environment to rewrite every stored URL
  from the old R2 domain to the new app-hosted one.
- **Plan B** (counter-proposal): leave every stored URL exactly as-is. Keep
  `media.zkproofport.app` as the literal hostname forever, but stop it from answering
  requests as R2 and make it answer as a Cloudflare Worker that proxies to
  `GET /api/media/{key}` on the app instead. No database write at all.

## Plan A — the risk, read from the actual script

`scripts/rewrite-media-urls.ts` (173 lines) is safer than a generic "find/replace across a
database" fear suggests, and less safe than "just flip a route" in one specific way. Concretely:

- **Match is literal, not regex.** `rewriteUrl()` uses `String.split`/`String.join` on a
  literal needle, never `new RegExp(oldBase)`. There is no regex-injection or
  catastrophic-backtracking surface, and special characters in the hostname (`.`) are
  matched literally, not as regex metacharacters.
- **It is anchored**, deliberately: the needle is always `oldBase + '/topics/'` or
  `oldBase + '/users/'` — the two literal roots `uploadObjectKey()` in `src/lib/r2.ts` ever
  produces — never the bare `oldBase`. The script's own comment states why: a `posts.content`
  row is user-authored HTML/text, and a bare-domain match would also rewrite a comment that
  merely *mentions* the CDN domain in prose, or a lookalike domain
  (`media.zkproofport.app.evil.example`) into a broken URL. Anchoring on the real key-root
  suffix means only an actual object URL — never prose — is ever touched, and only the exact
  `oldBase` substring is replaced; nothing else in the surrounding string (HTML tags, other
  attributes, unrelated text) is parsed or altered. A "bad replace corrupting article bodies"
  in the sense of mangled HTML structure is not a realistic failure mode of this specific
  script — a bad *value* (see below) is.
- **It is idempotent**, and states so: a second run finds no rows still containing `oldBase`
  and changes nothing. This matters because the script commits **row by row**
  (`UPDATE ... WHERE id = $3` per row, no wrapping transaction across the whole run) — if it
  crashes or is killed mid-run, some rows are rewritten and some are not, but re-running it
  to completion self-heals that partial state rather than requiring a restore.
- **Reversibility is real but two-part, not a single undo.** You can swap `OLD_R2_PUBLIC_URL`
  and `NEW_R2_PUBLIC_URL` and re-run to put the literal strings back — the values are known
  and documented (the script's own usage comment, the test fixtures). But the documented
  ordering (§ "Ordering with the bucket flip" in the script's header) runs this script
  *before* removing the bucket's public access, specifically so the old URLs keep working
  throughout. Once step 3 (remove public access) has actually happened, reversing the URL
  rewrite alone does not restore working images — the bucket's public binding would also need
  to be restored. So "rollback" is: swap-and-rerun the script **and** re-enable bucket public
  access, not either alone.
- **Real risk is operational, not structural.** The literal, anchored match means a wrong
  `NEW_R2_PUBLIC_URL` value (typo, or a mismatched staging/production pairing) rewrites every
  matched row *consistently* to a uniformly broken URL — every affected image now 404s — not a
  structurally corrupted HTML body. That is a real outage class (every post/topic/avatar image
  goes dark until corrected) but it is a much narrower failure mode than "corrupted article
  bodies," and it is the same class of mistake Plan B's Cloudflare config changes can also
  produce (a wrong Worker/route target breaks images too — see Plan B risks below). What Plan A
  uniquely carries is the requirement to run write access against a **live production
  Postgres database with elevated privileges** (`DATABASE_URL`) to fix it, which is a heavier
  incident-response tool to reach for than a Cloudflare dashboard change.

**Staging vs production — does the script handle it?** Yes, by design, but it puts the burden
on the operator, not the script. `R2_PUBLIC_URL`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` are **all** resolved from separate per-environment GitHub secrets in
`/Users/nhn/Workspace/proofport-app-dev/.github/workflows/deploy.yml`:

```
R2_PUBLIC_URL=${{ secrets[format('{0}_R2_PUBLIC_URL{1}', steps.env.outputs.ENV_UPPER, steps.cfg.outputs.SUFFIX)] }}
```

— i.e. `STAGING_R2_PUBLIC_URL[_NEW]` vs `PRODUCTION_R2_PUBLIC_URL[_NEW]` (the `_NEW` suffix
applies when `target_project=masselabs`, the current corporate GCP project — see
`deploy.yml:81-101`). `docs/migration/cloudflare-setup.md` §4 additionally confirms staging
and production use **physically separate R2 buckets** (`openstoa-prod` vs `openstoa-stg`), so
they are very likely on separate `R2_PUBLIC_URL` values too, though I could not verify the
literal staging hostname (see Open Questions). The script itself takes `OLD_R2_PUBLIC_URL` /
`NEW_R2_PUBLIC_URL` / `DATABASE_URL` as environment variables per invocation and does one
`WHERE ... LIKE '%oldBase%'` scan — it does not know or guess which environment it's pointed
at. That is actually a safe design for the mismatch case: running it against staging's
database with production's old/new hostnames finds zero matching rows (a no-op, not
corruption) because the `LIKE` filter simply won't match a domain that was never stored there.
The risk is not corruption, it's **false confidence** — an operator who runs it with the wrong
pairing sees "0 rows changed" and may believe the environment is clean when they simply
targeted the wrong hostname pair. The script must be invoked twice, deliberately, once per
environment, with that environment's own old/new pair — nothing enforces this operationally
beyond the header comment.

## Plan B — the mechanism, verified against Cloudflare's docs

### Can a Worker take over a hostname an R2 custom domain already owns?

Cloudflare's official docs describe Worker **Routes** vs Worker **Custom Domains** taking
precedence over each other on a shared hostname ("Routes can `fetch()` Custom Domains and take
precedence if configured on the same hostname" —
[Routes docs](https://developers.cloudflare.com/workers/configuration/routing/routes/)), but
that page is about two *Workers* features coexisting — it says nothing about an **R2 bucket's**
custom-domain binding, which is a different product surface. I could not find any Cloudflare
documentation that states whether an R2 custom domain and a Workers Route/Custom Domain can
coexist on the same hostname, or what happens if you try. This is a genuine gap in the public
docs, not something I'm inferring from a search summary.

It turns out not to matter for Plan B, because the standard, documented pattern for
"authenticate before serving from R2" **does not use the R2 custom-domain feature at all** —
it binds the bucket directly to a Worker (`r2_buckets` binding in the Worker's config) and
attaches *that Worker* to the desired hostname, bypassing R2's own public-access path
entirely (see
[Lei Mao's write-up](https://leimao.github.io/blog/Cloudflare-Worker-Proxy-R2-Bucket-Access/),
which uses exactly this shape: `R2 bucket: Select ... from the dropdown` as a Worker binding,
not a bucket-level custom domain). Applied to Plan B (which proxies to the app instead of
reading R2 directly, since the app already owns the authorization logic): the R2 custom domain
on `media.zkproofport.app` needs to be **disconnected** regardless of whether it technically
could coexist with a Worker, because Plan B's entire goal is for every request to that
hostname to reach the Worker's auth check, never R2 directly — leaving R2's public binding
live would defeat the privatisation this whole project exists to do. That disconnection step
is not Plan-B-specific overhead: **both plans require removing the bucket's public access** —
it is the one step that is common to both, not an extra cost of Plan B.

What happens when you disconnect it, per the
[R2 public buckets docs](https://developers.cloudflare.com/r2/buckets/public-buckets/):
*"This step also removes the CNAME record pointing to the domain."* — so disconnecting also
deletes the DNS record R2 created. To re-attach the same hostname to a Worker afterward, the
[Routes docs](https://developers.cloudflare.com/workers/configuration/routing/routes/) state
plainly which of the two Workers features to use for this exact shape: *"If your Worker is
your application's origin, use Custom Domains."* — a Workers Route needs a **pre-existing**
proxied DNS record (*"All domains and subdomains must have a DNS record to be proxied on
Cloudflare and used to invoke a Worker"*), which the R2 disconnect just deleted, while a
Workers Custom Domain manages its own DNS record the same way R2's custom domain did. So the
concrete sequence is: (1) disconnect the R2 custom domain from `media.zkproofport.app`
(deletes R2's CNAME), (2) add a Workers Custom Domain for `media.zkproofport.app` pointing at
the new proxy Worker (Cloudflare creates the new DNS record). This is a standard, well-trodden
Cloudflare pattern, not a novel or risky configuration.

### The Worker

Incoming request: `GET /topics/{topicId}/posts/{uuid}/{filename}` (or one of the other three
key shapes) on `media.zkproofport.app` — no `/api/media` prefix, because that's exactly the
raw R2 key every stored URL already carries. It has to become
`GET https://<app-host>/api/media/topics/{topicId}/posts/{uuid}/{filename}` on the app, with
the caller's `Cookie` and `Authorization` headers intact, because the route's authorization
(`GET /api/media/[...key]`) depends entirely on `getSession(request)` reading one of those two.

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // env.APP_ORIGIN = "https://openstoa.xyz" (a Worker secret/var, not hardcoded)
    const target = new URL(`/api/media${url.pathname}`, env.APP_ORIGIN);

    // `new Request(url, request)` clones method, headers (Cookie, Authorization —
    // everything), and body from the incoming request onto the new URL. This is
    // Cloudflare's own documented pattern for changing a request's destination
    // while preserving the rest of it:
    // https://developers.cloudflare.com/workers/examples/modify-request-property/
    const proxied = new Request(target.toString(), request);

    const resp = await fetch(proxied);

    // Reflect the app's status/headers verbatim: the Content-Type and the
    // public-vs-private Cache-Control split are already decided correctly by
    // GET /api/media/[...key] — the Worker adds nothing and overrides nothing.
    return new Response(resp.body, resp);
  },
};
```

`fetch()`'s target `Host` header is derived from `target`, not copied from the incoming
request, so the app receives a normal-looking request to its own hostname — no rewriting of
`Host` is needed.

### Does the caller's Cookie actually survive the trip? — this is the load-bearing question, and the answer is no for the majority of real traffic

The Worker code above only forwards whatever `Cookie` header the **browser already decided**
to attach to its request to `media.zkproofport.app` — a Worker cannot inject a cookie the
browser withheld, because that decision happens client-side before the request ever leaves the
browser. Whether the browser attaches the session cookie is governed by the cookie's `Domain`
attribute, which `setSessionCookie()` in `src/lib/session.ts:107-115` sets like this:

```ts
response.cookies.set(COOKIE_NAME, token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 7,
  path: '/',
});
```

No `domain` option is passed. Per
[MDN's cookie guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies):
*"If the `Set-Cookie` header does not specify a `Domain` attribute, the cookies are available
on the server that sets it but not on its subdomains"* — this is a **host-only cookie**. And,
separately: *"a server can only set the `Domain` attribute to its own domain or a parent
domain, not to a subdomain or some other domain."*

Applying that to the app's actual hosts (`CLAUDE.md`: `openstoa.xyz` primary production,
`community.zkproofport.app` also live production, `stg-community.zkproofport.app` staging) vs
the fixed media host `media.zkproofport.app`:

- A user authenticated on **`openstoa.xyz`** gets a cookie host-only to `openstoa.xyz`. It is
  **never** sent to `media.zkproofport.app` under any configuration — `openstoa.xyz` and
  `zkproofport.app` are different registrable domains, and per the MDN rule above a cookie can
  never be scoped outside its own domain's parent chain. No Cloudflare trick on the
  `media.zkproofport.app` side can retrieve a cookie the browser never sent in the first place.
- A user authenticated on **`community.zkproofport.app`** gets a cookie host-only to that exact
  subdomain. `media.zkproofport.app` is a *sibling* subdomain (same parent `zkproofport.app`,
  different host) — a host-only cookie is not sent to siblings either, only widening `Domain`
  to the shared parent (`Domain=zkproofport.app`) would fix this pairing specifically.

So, as the session cookie is configured today, **every `openstoa.xyz` user's browser-rendered
`<img>` tag against a private- or secret-topic image, or an ungated user-upload draft, arrives
at the Worker with no session cookie at all** — the app's route then correctly (from its own
point of view) treats the request as an unauthenticated guest and returns 401 on anything that
isn't public. That is precisely the class of image M-5 exists to protect, so Plan B as
literally specified silently regresses exactly the traffic it's supposed to serve, for the
domain `CLAUDE.md` calls out as canonical. Widening the cookie's `Domain` to `zkproofport.app`
would close the gap for `community.zkproofport.app` users only; it structurally cannot help
`openstoa.xyz` users, by the cookie spec, not by a fixable implementation detail.

Two things this does **not** break, and are worth separating out because they're the more
common non-browser access pattern:

- **`Authorization: Bearer` callers (curl, MCP/CLI agents) are unaffected either way.** A
  script explicitly setting its own `Authorization` header sends it to whatever URL it's given
  — there's no browser same-site cookie policy involved for a manually-constructed HTTP
  request, under Plan A or Plan B.
- **A browser's own `<img>` tag cannot carry a custom `Authorization` header at all** — HTML
  has no attribute for it — so Bearer auth was never going to cover the inline-image case under
  either plan; only the cookie path was ever realistic for that surface, which is exactly the
  path Plan B breaks for `openstoa.xyz`.

### Edge-cache risk

`media.zkproofport.app` would become a Cloudflare-proxied ("orange-clouded") hostname, and
Cloudflare's CDN can cache responses at the edge independent of the Worker's own logic. Per
[Cloudflare's default cache behavior docs](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/):
Cloudflare does not cache a response when *"The `Cache-Control` header is set to `private`,
`no-store`, `no-cache`, or `max-age=0`."* The M-5 route already sets
`Cache-Control: private, ...` for every non-public object and the Worker forwards that header
unmodified (`new Response(resp.body, resp)` copies headers verbatim), so by Cloudflare's
documented default this should not get cached at the edge and re-served to a different,
unauthorized user. That said, Cloudflare's docs don't explicitly state whether a
**Worker-returned** response (as opposed to a static origin response) follows the exact same
default rule — I could not find a page that says so directly — so this is a real thing to
verify with an actual cross-user request test before relying on it in production, not
something to assume from the general cache docs alone.

### What Plan B costs that Plan A does not

- **An extra network hop** on every image load: browser → Cloudflare edge (Worker) → GCP Cloud
  Run (the app) → back. Plan A serves the same request in one hop once the URL points directly
  at the app.
- **A new piece of infrastructure to operate**: a Worker script, its `APP_ORIGIN` binding, and
  a Workers Custom Domain, none of which exist today. Plan A reuses infrastructure that
  already exists (the app's own `/api/media` route, already built and documented) and needs no
  new Cloudflare resource at all.
- **Cloudflare Workers billing**: per the
  [Workers pricing docs](https://developers.cloudflare.com/workers/platform/pricing/), the free
  plan includes 100,000 requests/day; the paid plan is $5/month base with "10 million included
  per month + $0.30 per additional million" requests. Every image load (every post thumbnail,
  every avatar, every topic cover, on every page view) becomes a billed Worker request under
  Plan B; Plan A adds no new billable surface beyond what Cloud Run already charges for.
  Encouragingly, the same docs state Cloudflare "does not bill for subrequests you make from
  your Worker" (the Worker's own `fetch()` call out to the app doesn't double-count as a second
  request), and CPU time — the other billed dimension — explicitly **excludes** time spent
  waiting on `fetch()` (per the
  [Workers limits docs](https://developers.cloudflare.com/workers/platform/limits/): *"Waiting
  on network requests (such as `fetch()` calls...) does not count toward CPU time"*), so a
  Worker this thin (URL rewrite + header passthrough) should stay CPU-cheap even at volume —
  but the flat per-request cost at high image-load volume is still a real, recurring bill Plan
  A does not have.
- **Loses the real client IP at the app** unless explicitly re-derived from a
  `CF-Connecting-IP`-style header, which the app does not currently read (a repo-wide grep for
  `x-forwarded-for` / `request.ip` / `clientIp` in `src/` found no IP-based logic today, so
  this is not an active bug, but it is a latent observability cost: Cloud Run's own access logs
  for `/api/media` traffic reached via the Worker would show Cloudflare's edge IP, not the end
  user's, unless someone wires that header through later).
- **Rollback is two Cloudflare changes, not one.** Because installing Plan B required
  disconnecting the R2 custom domain in the first place (see above), reversing it means
  disabling the Worker's Custom Domain **and** re-adding the R2 custom domain — not a single
  toggle. It is still true, and the real point in Plan B's favor, that none of this touches the
  database: the rollback is entirely infrastructure config with no risk of a bad SQL write, no
  restore-from-backup path, and no live-table lock contention — that property holds regardless
  of whether it's exactly "one flip."
- **A second thing that can silently drift from the app's auth logic.** If `GET /api/media`'s
  authorization rules ever change (e.g. a new key shape, a new visibility tier), the Worker
  needs zero changes (it's a dumb proxy) — but the Worker *is* one more deployed artifact, in a
  different repo/toolchain (Wrangler, not this Next.js codebase), that has to be remembered to
  exist at all when someone is debugging a 401 on an image and doesn't think to check
  Cloudflare.

## Open questions neither plan fully answers

1. **Does R2's bucket-level custom domain and a Workers Route/Custom Domain actually conflict
   if both target the same hostname, and does removing one auto-clean the other's DNS record,
   or leave an orphaned record behind?** Cloudflare's public docs don't say. Verifiable only by
   trying it (recommend a scratch subdomain, not `media.zkproofport.app`, as a dry run).
2. **Does a Cloudflare Worker's own returned Response follow the exact same default
   cache-control-respecting behavior as a static/origin response?** The general cache docs
   don't distinguish Worker-returned responses explicitly. Should be verified with a real
   cross-session request/response test (two different logged-in users hitting the same private
   image URL back-to-back through the real Worker) before trusting it with private topic
   images.
3. **What is staging's actual `R2_PUBLIC_URL` hostname?** GitHub Secrets aren't readable by me.
   `docs/migration/cloudflare-setup.md` §4 documents production's custom domain only.
   `AGENTS.md` (root) shows one example response using
   `https://media.zkproofport.app/staging/posts/<uuid>/photo.png` — a `/staging/` path prefix
   under the *same* hostname — but that's inconsistent with what `uploadObjectKey()` in
   `src/lib/r2.ts` actually generates (never a leading `staging/` segment; `parseMediaObjectKey`
   in the M-5 route would reject a 6-segment key like that with 400). This reads like a stale
   illustrative example rather than the real staging URL shape, but I could not confirm either
   way, and neither plan's design was cross-checked against a real staging hostname because I
   don't know what it is.
4. **Would Cloud Run accept and correctly authorize a request whose source is Cloudflare's edge
   IP rather than an end user's browser?** Nothing in the codebase suggests it wouldn't (no
   IP-allowlisting or IP-based rate limiting found on this path), but this hasn't been tested
   end-to-end.
5. **If the cookie's `Domain` were widened to fix `community.zkproofport.app`, does that
   introduce any new cross-subdomain session risk** (e.g. a different, less-trusted
   `*.zkproofport.app` subdomain being able to read/replay the session cookie)? Not evaluated
   here — this would need its own review before touching `session.ts`, and only partially fixes
   Plan B in any case (see above — `openstoa.xyz` stays broken regardless).

## Recommendation

I'd pick **Plan A**. Plan B's core promise — "no database write, rollback is trivial" — is
real for the encrypted-content-corruption fear specifically, but the mechanism as proposed
does not actually work for the traffic that matters most: a signed-in `openstoa.xyz` user
loading a private- or secret-topic post would silently see a broken image (401 behind the
scenes) because the session cookie, as currently scoped, never reaches `media.zkproofport.app`
in a browser context — and `openstoa.xyz` is the domain `CLAUDE.md` names as canonical. Fixing
that would require widening the cookie's `Domain`, which only closes the gap for
`community.zkproofport.app` and cannot structurally help `openstoa.xyz` at all — cookies can't
cross registrable domains, full stop. Plan A's script, read closely, is much safer than "a bad
replace could corrupt article bodies" suggests: it's a literal, anchored, idempotent
substring-swap that can only ever touch an actual object URL, never surrounding HTML or prose,
and its real failure mode (a wrong hostname pairing) breaks images uniformly rather than
corrupting content — a real but bounded, and self-healing-by-rerun, risk. I'd still want a
`--apply` dry run reviewed against a staging snapshot before running it against production, and
I'd want open question #3 (the actual staging hostname) resolved first so that dry run tests
the real thing.

## Sources

- [Cloudflare Workers — Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) — Route vs Custom Domain precedence; DNS record prerequisite for Routes.
- [Cloudflare R2 — Public buckets (custom domains)](https://developers.cloudflare.com/r2/buckets/public-buckets/) — what connecting/disconnecting a custom domain does to DNS.
- [Cloudflare Workers — Modify request property example](https://developers.cloudflare.com/workers/examples/modify-request-property/) — `new Request(url, request)` pattern used in the Worker snippet above.
- [Cloudflare Cache — Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) — `Cache-Control: private` is not cached at Cloudflare's edge by default.
- [Cloudflare Workers — Pricing](https://developers.cloudflare.com/workers/platform/pricing/) — free tier, paid tier, subrequests not separately billed.
- [Cloudflare Workers — Limits (CPU time vs wall time)](https://developers.cloudflare.com/workers/platform/limits/) — `fetch()` wait time excluded from billed CPU time.
- [MDN — HTTP Cookies guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies) — host-only cookie behavior; `Domain` attribute can only be set to the setting host's own domain or a parent, never a sibling or unrelated domain.
- [Lei Mao — Cloudflare Worker Proxy R2 Bucket Access](https://leimao.github.io/blog/Cloudflare-Worker-Proxy-R2-Bucket-Access/) — third-party, illustrates the "bind R2 to a Worker directly, don't use R2's own custom domain" pattern referenced in the Plan B mechanism section.
