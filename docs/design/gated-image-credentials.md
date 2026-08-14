# Gated image credentials: why the mini-app and the two web hosts can't authenticate today, and three ways to fix it

Status: research only. No application code, infrastructure, or database changes. No
throwaway proof-of-concept was needed — reading settled every open question below (see
"Why no POC" under Candidate A).

Related: [`media-bucket-privatisation.md`](./media-bucket-privatisation.md) — that doc
established the fact this one leans on repeatedly: `setSessionCookie()`
(`src/lib/session.ts:107-115`) sets no `domain` option, so the session cookie is
**host-only**, and host-only cookies never cross a registrable-domain boundary. Todo M-6
in the project tracker.

## The problem

`GET /api/media/{key}` gates reads by session (`getSession(request)` — cookie or Bearer).
Two real surfaces cannot supply either credential today, invisibly, because the R2 bucket
is still public and no request has ever actually needed the gate to pass:

**(1) The mini-app never sends a cookie, on purpose.** `packages/mobile/src/api/openstoaClient.ts:240`
authenticates every API call with `Authorization: Bearer <token>` and explicitly sets
`credentials: 'omit'`:

```ts
// CRITICAL: explicitly omit cookies on every request. The native iOS
// cookie store persists across logout (we only clear AsyncStorage
// tokens), so without this any stale `zk-community-session` cookie
// from a previous authenticated session would be sent automatically
// and the server would treat the user as still-authenticated — even
// when `clientMode === 'guest'` ...
let res = await fetch(url, { ...init, headers, credentials: 'omit' });
```

That comment describes a real, already-fixed bug — nothing here proposes touching it.
But every remote image renders as a bare `<Image source={{ uri }}>`, with **no**
`headers`, meaning no credential reaches `GET /api/media/{key}` at all:
`PostCard.tsx:546` (author avatar), `ProfileHomeScreen.tsx:811` (own avatar),
`PostDetailScreen.tsx:93` (`Avatar` helper), `PeerProfileCard.tsx:191` (peer avatar),
`EditProfileScreen.tsx:589` (own avatar edit view). A grep for `headers:` next to a `uri`
in `packages/mobile/src` returns nothing.

**There is a sixth site the task description didn't name, and it changes the shape of the
mobile fix**: `packages/mobile/src/components/PostContent.tsx` renders a post's HTML
`content` — including inline `<img src="...">` tags — through `react-native-render-html`
(`import RenderHtml ... from 'react-native-render-html'`), and this is not dead code:
`PostCard.tsx:465` and `:653` say *"tags are rendered by PostContent in place"* and
*"PostContent renders inline `<img>` tags too"*, and no call site
(`PostBodyWithOg.tsx:82/89/98/100`) passes the `omitImages` prop that would strip them.
So the mini-app has **two** distinct image-rendering integration points, not one: plain
`<Image>` for avatars, and a third-party HTML renderer's own image pipeline for post
bodies.

**(2) Two web hosts, one hostname-bound cookie.** `openstoa.xyz` and `community.zkproofport.app`
both serve real user traffic (`CLAUDE.md`: "primary" and "also live" respectively).
`R2_PUBLIC_URL` is a single value naming one hostname (`media.zkproofport.app` today,
per the sibling doc). A user's session cookie is host-only to whichever of the two hosts
they signed in on — it is never sent to the third, fixed `media.zkproofport.app` domain,
for the same reason established in the Plan B section of the sibling doc: cookies cannot
cross a registrable-domain boundary, full stop, regardless of Cloudflare configuration on
the receiving end.

## Evaluating three candidates

### Candidate A — Bearer token as an `<Image>` header

**Fixes:** the mini-app only. Does nothing for the two-host web problem — a plain
`<img>`/`<Image>` credential and a cookie are different mechanisms entirely; fixing the
app's Bearer plumbing has no effect on a browser tab.

**The mechanism exists and is documented for both mobile image paths:**
- Plain `<Image>`: the `source.headers` field is real —
  [React Native's docs](https://reactnative.dev/docs/image) describe it as *"An object
  representing the HTTP headers to send along with the request for a remote image."*
- HTML-embedded `<img>` inside `PostContent.tsx`: `react-native-render-html` has a
  `provideEmbeddedHeaders(uri, tagName)` prop for exactly this —
  [its docs](https://meliorence.github.io/react-native-render-html/docs/content/images)
  give the literal example:
  ```js
  function provideEmbeddedHeaders(uri, tagName) {
    if (tagName === 'img') {
      return { Authorization: "Bearer XYZ" };
    }
  }
  ```

**What it actually costs — the token-plumbing question, read from the real client:**

`OpenStoaClient.tryGetToken()` (`packages/mobile/src/api/openstoaClient.ts:138-155`) is
declared `private async` — **there is no synchronous path to the current token anywhere
in the client**, even on the fast path where `this.cachedToken` is already populated,
because an `async function` always returns a Promise. So the answer to "is the token
already available synchronously somewhere" is no: every one of the six render sites would
need to either (a) `await` a token before it can construct `source.headers`, or (b) read a
value that some OTHER piece of code already resolved and is holding in reactive state.
(b) is the only workable shape for a scrolling `FlatList` of `PostCard` rows — option (a)
means every row blocks on its own async call before its `<Image>` can even mount, which is
both wasteful (N independent calls resolving to the same cached value) and produces a
flash of nothing while each row's promise is in flight.

The codebase already has a precedent for "hand out the current credential to a consumer
outside the normal `client.request()` flow": `pushSessionCredential()`
(`openstoaClient.ts:123-131`), built for the iOS Notification Service Extension to fetch
an encrypted attachment for a push preview. It's a single async call per push payload,
not a per-row pattern, but it establishes that the client is already designed to expose
its credential to a second consumer — the natural extension is to hoist the resolved
token into React state (Context, or the existing query/store layer) once per session and
have all six render sites read that state synchronously, rather than each calling
`tryGetToken()` independently.

**Does it change on refresh, and what happens to already-rendered images?** Yes, it
changes — `tryGetToken()` calls `refreshOnce()` when the cached token is within
`refreshLeadMs` of expiry. Whether that matters to an already-loaded image depends on
RN's `Image` cache key. The official docs don't state this explicitly, but a
[cross-referenced community source](https://blog.logrocket.com/caching-images-react-native-tutorial-with-examples/)
and the RN default cache mode (`immutable`, keyed by URI) both point the same way: RN's
built-in `Image` cache is keyed by **URI only**, not headers. Since candidate A pairs with
a *stable* URL (the `/api/media/{key}` path never rotates, unlike a signed URL — see
Candidate C), this cuts both ways:
- **Good**: an image that has already loaded successfully stays cached and displayed
  regardless of what the token does later — no thrashing, no re-fetch storm on refresh.
- **Bad**: a cache **miss** (first mount, low-memory eviction, app relaunch) always fetches
  fresh and always needs whatever token is *currently* in the reactive store to be valid
  at that exact moment. If a row mounts during the narrow window where the old token has
  expired and the refresh hasn't resolved yet, that fetch 401s, and RN's `Image` does not
  automatically retry just because some unrelated state changed later — the app would need
  its own `onError` handler that requests a fresh token and forces a re-fetch (typically by
  changing the `source` object reference, since that's what actually triggers a new
  request). That retry loop is new code, not a side effect of adding `headers`.

**A documented trap for later, not today:** `facebook/react-native#13697` — I fetched it
directly rather than trusting the task description's paraphrase, and the precise finding
is slightly different from "headers are ignored on arrays": `headers` must be supplied
**once, at the top level, applying to every image in a multi-resolution `source` array** —
unlike `cache`, which is per-URI. Not a limitation for us today (the mini-app passes
single objects, and even in an array every image would want the *same* Authorization
header), but it means a future multi-resolution source array mixing an authenticated and
an unauthenticated image could not carry different headers per entry. The issue is closed
as working-as-designed, not a live bug to track.

**What could go wrong at 3am:** a bug in the refresh-timing logic (not the token itself,
the *plumbing* that keeps reactive state in sync with `tryGetToken()`'s internal refresh)
means a burst of image 401s that looks identical, from the server's point of view, to a
credential-stuffing pattern or a mass logout — nothing in the request itself
distinguishes "client sent a stale Bearer because of a client bug" from "a session
actually expired." And because this candidate is mobile-only, a broken rollout produces a
confusing bug report shape: "images broken in the app, fine on the website" (or the
reverse, if web is fixed by something else) — worth remembering when triaging.

**Why no POC:** the two open questions in the brief — is a sync token available, and what
happens on refresh — were both answered by reading the client's actual source and RN's own
cache-key behavior, not by anything only executable code could reveal. The remaining
uncertainty (exact interaction between a live `onError` retry and RN's cache on a specific
OS version) is a pre-ship verification step on a real device, not a research question a
scratch file resolves either.

### Candidate B — root-relative `R2_PUBLIC_URL` (`/api/media`)

**Fixes:** both web hosts, structurally, not just as a workaround. This is worth stating
plainly because it's the deeper reason B is attractive: `openstoa.xyz` and
`community.zkproofport.app` are two *different registrable domains* (confirmed in the
sibling doc), so no cookie-domain trick can ever make one session's cookie valid on a
fixed **third** hostname like `media.zkproofport.app` — that's a hard boundary, not a
configuration gap. A root-relative `R2_PUBLIC_URL` removes the third hostname from the
picture entirely: every image request becomes same-origin to whichever host served the
page, using that host's own, already-working, host-only cookie — the exact same trust
relationship every other `/api/...` call on that page already has. This isn't specific to
images; it's why the rest of the API has never had a two-host problem.

**What it costs, read from the real code, not assumed:**

1. **Two ownership checks compare against `R2_PUBLIC_URL` as a string prefix, and both
   still work, but the check gets structurally weaker.** `src/app/api/profile/image/route.ts:138`:
   `if (!imageUrl.startsWith(R2_PUBLIC_URL))`, and `src/lib/r2.ts:449-450`:
   `const prefix = \`${config.R2_PUBLIC_URL}/\`; if (!url.startsWith(prefix))`. With an
   absolute `R2_PUBLIC_URL`, this check incidentally also verifies protocol + host. With a
   relative one (`/api/media`), it verifies only that the string starts with that literal
   path — a caller no longer needs to know our real domain to construct a value that
   passes. That doesn't create a *new* authorization hole by itself (this check was never
   "do you own this specific object," only "is this shaped like one of our media URLs" —
   `parseMediaObjectKey` and the M-5 route's own gates are what actually authorize a
   *read*, and `PUT /api/profile/image` never re-validates ownership of the object being
   pointed at either way), but it is a real, if modest, lowering of the bar for a
   low-effort/automated caller, worth a one-line note in the PR that makes this change.
2. **A third self-consistency point, not just the two `startsWith` checks**:
   `gateUserUpload` in the M-5 route (`src/app/api/media/[...key]/route.ts`) reconstructs
   a candidate URL as `${tryGetR2PublicUrl()}/${objectKey}` and compares it against
   `topics.image` to decide whether an ungated user-upload is currently serving as a
   topic's cover. This keeps working under a relative base, but only if `topics.image` is
   *also* stored relative — reinforcing the invariant every write path needs to hold:
   **once `R2_PUBLIC_URL` is relative, every stored URL (`posts.content`,
   `posts.media.images[]`, `topics.image`, `users.profile_image`) must stay relative and
   opaque end-to-end.** No client may absolutize a URL before handing it back to the app
   (e.g. in `PUT /api/profile/image`'s `imageUrl` body) — only at render time. That's a new
   discipline across three codebases (web, mobile, any third-party/agent client), not
   enforced by any test today.
3. **The mini-app fix is real, but more tractable than "breaks the mini-app" suggests —
   there's already a proven pattern for it in this exact codebase.** `useOgPreview.ts:85`
   and `ChatRoomScreen.tsx:2215` both carry the identical `absolutize()` helper:
   ```ts
   const absolutize = (u: string | null): string | null => {
     if (!u) return u;
     if (u.startsWith('http')) return u;
     if (u.startsWith('/')) return `${baseUrl}${u}`;
     return u;
   };
   ```
   where `baseUrl = client.getBaseUrl()` — a public method that already exists on
   `OpenStoaClient` (`openstoaClient.ts:110-112`, doc comment: *"Canonical OpenStoa server
   origin... Use for share links."*) and, unlike the token, **is synchronous** — no
   plumbing problem here at all. Applying the same helper to the plain-`<Image>` sites
   (`PostCard`, `ProfileHomeScreen`, `PostDetailScreen`, `PeerProfileCard`,
   `EditProfileScreen`) is mechanical: wrap each `uri` in `absolutize()` before handing it
   to `<Image>`.
   For the sixth site — `PostContent.tsx`'s HTML-embedded `<img>` — this needs no custom
   code at all: `react-native-render-html` has a first-class feature for exactly this,
   `useNormalizedUrl` / `source.baseUrl` — per
   [its docs](https://meliorence.github.io/react-native-render-html/api/usenormalizedurl):
   *"transforms relative and protocol-relative URLs to absolute URLs, with the base URL
   determined by the `<base />` element, `source.uri` or `source.baseUrl`."* Passing
   `client.getBaseUrl()` as `source.baseUrl` when constructing the `RenderHtml` element
   should resolve every relative `<img src="/api/media/...">` automatically. So: real,
   currently-broken, and genuinely needs an audit across six call sites — but the fix at
   each site is copy-paste of an already-shipped pattern, not new design.
4. **Anything handed to a genuine third party still needs an absolute URL, and today
   nothing does.** I checked for dynamic per-post/per-topic Open Graph image generation
   (the one case where an *external, unauthenticated* crawler — Twitter/Discord/Slack
   preview bots — would need a real absolute URL, since `metadataBase`-relative resolution
   only helps first-party Next.js metadata, not arbitrary external consumers) and found
   none: `src/app/layout.tsx` sets one static, site-wide `openGraph` image with
   `metadataBase: new URL('https://www.openstoa.xyz')` already set; no `generateMetadata`
   anywhere pulls a post's `content` image or a topic's `image` into an OG tag. Worth
   flagging as a forward-looking constraint (a future "rich link preview for a shared
   post" feature would need explicit absolutizing at that point, and — separately — could
   never serve a gated image to an anonymous crawler under *any* of these three candidates
   anyway, since a crawler has no session to authenticate with in the first place; that's
   an orthogonal limitation, not specific to B).

**What could go wrong at 3am:** something that assumed an absolute image URL — most
plausibly a hardcoded `url.startsWith('http')` check, of which the codebase already has at
least one working example in `useOgPreview.ts` itself — silently starts treating a valid
relative media URL as "needs no absolutizing" or vice versa, and the failure mode is a
broken image with no server-side error at all (the server never sees the request, because
the client resolved the URL wrong before ever calling out) — much harder to spot in
server logs/monitoring than a spike in 401s would be.

### Candidate C — short-lived signed URL / token query parameter

**Fixes:** all three surfaces (mobile, both web hosts, and a plain `<img>`/curl with zero
credential-plumbing) in one mechanism, because the credential travels *inside* the URL
itself — no header, no cookie, no origin dependency.

**How this is normally done, verified against the two most relevant references for this
stack:**
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html):
  *"A presigned URL uses security credentials to grant time-limited permission to download
  objects... The credentials used by the presigned URL are those of the AWS user who
  generated the URL."* Signing is server-side, using the account's own credentials — a
  client never signs its own URL. Max expiry via the CLI/SDK is 7 days; via the console,
  12 hours.
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) —
  directly relevant because **R2 is our actual storage**, and the SDK for this,
  `@aws-sdk/s3-request-presigner`, is **already an installed dependency**
  (`package.json:25`, `^3.1005.0`) even though nothing in `src/lib` currently calls
  `getSignedUrl`. Expiry range: 1 second to 7 days. And the security model, stated in
  Cloudflare's own words: *"Treat presigned URLs as bearer tokens. Anyone with the URL can
  perform the specified operation until it expires."* Confirmed to work on a **fully
  private** bucket — no public-access configuration needed at all, which is actually the
  cleanest fit for where M-5 wants to end up.

So the natural implementation of C in this stack is not "invent a custom HMAC scheme" —
it's the app doing its existing session/topic-membership check (the same logic
`GET /api/media/{key}` already has), then minting an R2 presigned GET URL for that one
object with the credentials `r2.ts` already holds, with no new secret or dependency.

**The part that's genuinely hard, and the task description named it correctly**: a
presigned/signed URL embeds a signature that will expire, but the SAME URL is what's
**stored** in `posts.content`, `topics.image`, `users.profile_image` — a value written
once and read arbitrarily far in the future cannot carry a signature valid at read time.
So the stored value has to stay the stable, unsigned `/api/media/{key}` shape (same as
Candidate A/B), and something has to mint the *signed* variant fresh, **on every read**,
which pushes the signing point to exactly one place that makes architectural sense: the
server, at the moment it serves a `GET /api/posts/{postId}` / `GET /api/topics/{topicId}` /
`GET /api/feed` response — not any of the three clients individually, since none of them
have R2 credentials and none of them should. Concretely, this means the server must walk
`content` (parsing `<img src>` out of user-authored HTML — the exact anchored, careful
substring-matching problem `scripts/rewrite-media-urls.ts` already solved once, as a
one-time offline migration), `media.images[]`, `topic.image`, and
`author.profileImage`/`profileImage`, and rewrite each occurrence to a freshly-signed URL,
**on every single response**, forever — not once.

**What that costs, beyond the implementation effort itself:**
- **Caching regression.** M-5's own route sets
  `Cache-Control: public/private, max-age=31536000, immutable` — a year-long cache,
  because re-checking a session is cheap and the underlying bytes never change. A signed
  URL's expiry caps how long ANY cache (browser, CDN, RN's `Image` cache) can usefully hold
  it — you cannot mark a URL "immutable for a year" when its own signature invalidates it
  in minutes or hours. Choosing a short expiry (tight security bound) directly fights
  caching; choosing a long one to preserve caching (days, up to R2's 7-day ceiling) means
  the leaked-URL exposure window approaches the scale of the ORIGINAL problem this whole
  project exists to close, just with an eventual, not immediate, cutoff.
- **Cache-key thrashing, confirmed by an independent source, not assumed**: per a
  [community writeup on RN image caching](https://blog.logrocket.com/caching-images-react-native-tutorial-with-examples/),
  *"if image URLs include signed tokens, temporary authentication parameters, or rotating
  query strings, every URL change is treated as a completely new resource"* under RN's
  default (URI-keyed) cache mode. The same avatar appearing on a feed post, a comment, and
  a profile page — today one cache entry — becomes three separately-signed URLs (minted at
  three different response times) and three separate cache entries and three separate
  fetches, on both the client `Image` cache and any browser/CDN cache in front of the web
  app.
- **What happens when a signed URL leaks (pasted into chat, screenshotted, or otherwise
  shared)?** Per Cloudflare's own framing above, it's exactly a bearer token: usable by
  anyone who has it until expiry, regardless of who they are. A short expiry bounds the
  blast radius; it does not eliminate the class of risk M-5 exists to close, it just
  puts a clock on it.

**What could go wrong at 3am:** two distinct failure classes, both worse than A or B's,
because C is the only candidate that touches all three surfaces through ONE shared
mechanism — a bug in it breaks everything at once, not one surface at a time. First: a
signing-key rotation, a clock-skew bug, or a bad deploy of the rewrite logic invalidates
every in-flight signature simultaneously — total image outage across mobile, both web
hosts, and any agent that cached a URL, indistinguishable at a glance from an attack.
Second, and specific to this candidate: the HTML-rewrite-on-every-read logic is new code
running on the hot path of every post/topic/feed response, forever — unlike Plan A's
rewrite script (a one-time, reviewable, offline migration run once per environment), a bug
in this logic ships to every live reader immediately and continuously. That reframes the
"anchored substring match" carefulness `rewrite-media-urls.ts` needed for a single
migration into a permanent production invariant that has to keep holding on every request,
not just get right once.

## Recommendation

**Candidate B**, with the mini-app absolutize work (six call sites, using patterns already
proven in this codebase) done as the same change, not deferred. Reasoning: B is the only
one of the three that removes the *structural* cause of the two-host problem — a fixed
third hostname that no cookie can ever legitimately reach — rather than working around it,
and its "breaks the mini-app" cost turned out to be real but mechanical once actually read
against the code (an existing `absolutize()` helper plus `react-native-render-html`'s own
`baseUrl` feature cover all six sites with no new design). C solves all three surfaces in
one mechanism, which is genuinely elegant, but it converts a one-time migration risk (what
Plan A already had to solve carefully, once) into a permanent per-request risk (HTML
rewriting on every read, forever) and reopens — in bounded, clocked form — the exact
bearer-URL exposure class this whole project exists to close, while fighting the caching
model M-5 already built. A alone is incomplete (mobile only) and, even paired with
something else for web, adds an ongoing token-freshness/retry surface that B doesn't need
at all.

**What would change my mind:** if the ownership-check weakening in Candidate B (item 1
above) turns out to matter more than I judged — e.g. if `imageUrl.startsWith(R2_PUBLIC_URL)`
is relied on elsewhere as a *bigger* trust boundary than I found by grepping for
`R2_PUBLIC_URL` in `src/`; or if a currently-hidden third-party consumer (an OG crawler, a
partner integration) turns out to depend on an absolute media URL that I didn't find. Also,
if the product direction shifts toward wanting images shareable-without-a-session by
design (e.g. a public "share this post" link that should render for a logged-out viewer),
that's a real use case only Candidate C serves — worth re-opening the recommendation if
that requirement shows up.

## Sources

- [React Native — Image (`source.headers`)](https://reactnative.dev/docs/image)
- [`facebook/react-native#13697`](https://github.com/facebook/react-native/issues/13697) — `headers` applies array-wide, not per-URI; closed as working-as-designed.
- [React Native Render HTML — Images (`provideEmbeddedHeaders`)](https://meliorence.github.io/react-native-render-html/docs/content/images)
- [React Native Render HTML — `useNormalizedUrl` / `source.baseUrl`](https://meliorence.github.io/react-native-render-html/api/usenormalizedurl)
- [LogRocket — Caching images in React Native](https://blog.logrocket.com/caching-images-react-native-tutorial-with-examples/) — URI-keyed cache; rotating query strings defeat caching.
- [AWS S3 — Sharing objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html) — who signs, expiry limits.
- [Cloudflare R2 — Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) — "treat presigned URLs as bearer tokens"; works on fully private buckets; 1s–7d expiry.
- [`media-bucket-privatisation.md`](./media-bucket-privatisation.md) — established the host-only cookie fact this doc builds on, and the two-web-host / registrable-domain constraint.
