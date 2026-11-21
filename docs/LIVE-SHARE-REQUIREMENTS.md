# Live Share — requirements

**Status:** v0 requirements — accepted 2026-11-21; the decisions in §13 are locked and §5 scope
follows from them. **v0 is implemented in this repo** — see §15 for what was built and what has
(and has not) been verified.
**Brief this derives from:** *"a location sharing web app similar to Life360 where users log in to the
portal to initiate a location sharing session with another user or users."*
**Grounded in:** this repo as it stands (`apps/api`, `apps/pwa`), `docs/ARCHITECTURE.md`, and the
platform constraints measured on the live Render deployment.

Priority key: **M** = must ship in v0 (the MVP) · **S** = should ship in v1 · **C** = could ship
later · **W** = won't ship, stated deliberately.

---

## 1. The product decision

The portal already has accounts (emailed six-digit code), a session cookie, one persisted resource
(notes), and a games area. Location sharing is the next vertical, and the brief asks for
*sessions* — a user starts sharing and later stops. That phrasing is the product.

A **Live Share** is a deliberate, time-boxed, mutual session:

> Sam opens the portal, taps **Share my location**, picks **30 minutes**, and sends Ana a link.
> Ana signs in, joins, and for the next 30 minutes both see where the other is, updated every
> ten seconds. At 18:42 it ends. Neither of them can see anything afterwards. Nothing was
> recorded.

### 1.1 How this differs from Life360, and why

Life360's promise is **persistent, passive awareness** — a family circle that keeps tracking in
the background, with history, place alerts, driving reports, crash detection and SOS on
subscription tiers ([features](https://play.google.com/store/apps/details?id=com.life360.android.safetymapd),
[plans](https://intl.life360.com/plans-pricing)).

| Life360 model | Live Share (this product) |
| --- | --- |
| A circle that persists | A share that is created, expires, and leaves nothing |
| Background location, always | Foreground sharing while the app is open — the only kind a browser allows (§2) |
| History, place alerts | None in v0; positions are overwritten, never accumulated |
| Driving safety, crash detection, SOS | Out of scope |
| Subscription product | $0 incremental on the existing free tier |

Two products would be wrong to pretend are one. A browser cannot deliver Life360's core promise,
and *this* product's sharper promise — "let me see you for the next half hour" — is the one a web
app can keep honestly. It is also the more defensible privacy story: consent is per-session, the
stop control is one tap, and the database holds no trail to leak. Say "Live Share", never
"tracking" — the naming is part of the architecture.

The brief's word "session" is kept, but **not** as a database noun: the auth layer already owns
`session`. The row is a **share** (`share`, `share_participant`, `share_invite`, `share_event`).

---

## 2. Platform facts that dictate the shape

These are not preferences. Each one is a requirement source, cited so it is not relitigated.

| # | Fact | Consequence |
| --- | --- | --- |
| F1 | **Browsers have no background geolocation.** A `watchPosition` watcher belongs to the open page; when the page is hidden, the screen locks, or iOS suspends it, updates stop. There is no web API for continued background location. | Sharing is **foreground-only**. The recipient must see honest freshness, and the sharer must be told the ceiling. This is why "keep the screen open" is a requirement, not a nag. `docs/ARCHITECTURE.md` §11 already names background location as a trigger to leave the PWA architecture. |
| F2 | **Geolocation requires a secure context.** `http://192.168.x.x` will not prompt. | Field testing needs the deployed HTTPS site (or `localhost`), never a LAN IP. |
| F3 | **Screen Wake Lock** is available on Chrome 84+ and Safari 16.4+ ([caniuse](https://caniuse.com/mdn-api_wakelock)); the lock is released when the page hides. | The share screen may hold the screen awake to keep the watcher alive; re-acquire on visibility. Feature-detect, never assume. |
| F4 | **No reliable push.** iOS requires install for Web Push (16.4+); install itself is optional. | Invitations must not depend on notifications. A share link sent through the owner's own messaging app is the transport; in-app state is polled. |
| F5 | **The free API instance sleeps.** Measured cold start 26.5 s after 17 min idle (`docs/ARCHITECTURE.md` §12), 0.1 CPU / 512 MB. | Requests must tolerate a ~30 s first response with retry and progress; no long-lived connection (SSE) in v0; no extra Render services. |
| F6 | **A share is a live, multi-client read/write workload.** Positions are tiny (a few dozen bytes per ping). | No new infrastructure: Postgres + the existing Hono API. Polling at 10 s is trivial load; a map cannot be served from this instance, so tiles come from a tile provider. |
| F7 | **The static site is a service-worker-cached shell.** Deploys are content-hashed, and an old shell can survive a resume (`docs/ARCHITECTURE.md` §7). | New routes are **additive**. An old shell keeps working with no share button; the stale-build self-heal already handles the rest. |
| F8 | **Client-reported data is the precedent** (leaderboard scores): bounds, not proof. | Positions are client-asserted. The server validates ranges; it cannot prove them. Say so (§6.9, FR-41) instead of implying anti-spoofing. |
| F9 | **The query cache persists to `localStorage`** (`apps/pwa/src/lib/query.ts`, `main.tsx`). | Positions are sensitive and must not be written to persisted storage, even though the shell would otherwise cache them (NFR-05). |
| F10 | **Render free Postgres expires** 30 days after creation; no backups. | Ephemeral by nature here — a good fit for no-history sharing — but the database must be moved off the free plan before real users (existing runbook item). |

---

## 3. Users, jobs, and who this is not for

### 3.1 Personas and jobs

**P1 — The worried friend (Sam).** Ana walks home at 23:10. Sam would rather see a moving dot than
send a fourth "you ok?" text. Job: reassurance with fresh position, cheaply, without installing
anything. Success: Sam can tell Ana is moving and arrives home. The session ends by itself.

**P2 — The meet-up coordinators (Ana and Dev).** Two or three people converging on a venue.
Job: "where are you, are you close?" Success: each can see the others within 15 s, no phone calls.
They share reciprocally, so both sides run the same flow.

**P3 — The parent on the school run.** Shares for 45 minutes with a partner while collecting kids.
Job: handoff visibility without a subscription. Success: one tap to start, one tap to stop, no
afterwards.

### 3.2 Who this is not for (explicit)

- **Surveillance without participation.** There is no viewer-only mode over someone else's position:
  every participant is a signed-in account that joined deliberately and is visible in turn. A
  recipient may choose not to publish their own position (`sharing=false`) and still see others —
  but they know they are in a share, and the owner knows they are not sharing.
- **Employers monitoring staff**, **finding a partner secretly**, **tracking a child who has no
  account**. The mutual-visibility rule and the join-link consent step block the obvious versions.
  The link can still be forwarded to the wrong person; §12 (risks) covers what mitigates that.
- **Continuous family tracking.** Not possible in a browser (§2, F1); shipped as a different
  product on purpose.

---

## 4. Goals, non-goals, success

### 4.1 Goals

- **G1.** Start a share in under 15 seconds from a cold launch, with one decision (whom, how long).
- **G2.** While both apps are open, a participant's position is visibly moving and at most ~15 s old.
- **G3.** Stopping, expiring, leaving or being removed ends visibility immediately and leaves **no
  coordinates behind**.
- **G4.** A first-time recipient understands what they are agreeing to — and that the sharer is
  also exposed — before they tap Join.
- **G5.** Zero new services, zero new monthly cost, zero new credentials on the free tier.
- **G6.** The data layer assumes nothing browser-only: the same API serves an Expo/native shell
  unchanged when foreground-only sharing stops being acceptable (`docs/ARCHITECTURE.md` §11).

### 4.2 Non-goals for v0

Location history or timeline · place/arrival alerts (geofences) · crash detection, driving reports,
SOS · battery or connectivity status of the other phone · in-app chat · background/always-on
tracking · anonymous (signed-out) participants · reverse geocoding or street addresses ·
routing/ETA · web push as a required channel · anti-spoofing.

### 4.3 Success metrics (v0)

| Metric | Target | Why it is the right metric |
| --- | --- | --- |
| Activation: shares that get ≥1 other participant | ≥ 80% | A share nobody joins is a failed invitation flow. |
| Time from share creation to first joiner's position seen | median ≤ 2 min | The whole value is immediate. |
| Freshness while foreground | median ≤ 15 s, p95 ≤ 30 s | Staleness, not latency, is what users judge. |
| Shares ended by explicit stop vs expiry | both used; no share outlives its cap | Proves the controls are findable. |
| Coordinates present on ended/expired shares | **0 rows** | The privacy claim is testable. |
| Retention sweep last ran successfully | every hour of traffic | Bounds the data even after expiry. |

---

## 5. Scope

| Capability | v0 | v1 | later | won't |
| --- | --- | --- | --- | --- |
| Start a timed share with N people | M | | | |
| Send single-use join links (copy / native share sheet / email) | M | | | |
| Live position list with freshness and accuracy | M | | | |
| Map view with accuracy circles | M | | | |
| Pause / stop / leave / remove participant | M | | | |
| Auto-expiry with 8 h cap | M | | | |
| Recent-people quick start | M | | | |
| Foreground-only, honest staleness | M | | | |
| Permission-denied degraded mode (see-only) | M | | | |
| Multi-tab single-publisher guard | S | | | |
| Adaptive battery-aware cadence | S | | | |
| Email delivery of the join link | S | | | |
| Block / report a person | | | C | |
| History, geofence alerts, SOS | | | C | |
| Native app shell (Expo) | | | C | |
| Background tracking on the web | | | | W (impossible) |
| Crash detection, driving reports, chat | | | | W |

---

## 6. Functional requirements

Every requirement below is testable, and the acceptance criteria are what a PR is checked against.
All share routes live behind the existing session gate, so **FR-01** is largely already true.

### 6.1 Accounts and identity

- **FR-01 [M]** Only signed-in users can create, read, join or end shares. Every `/api/shares/*`
  request without a valid session is `401`, and the API gate in `app.ts` keeps that true by
  default.
  *Acceptance:* curl without the cookie → `401` on every share route; the client signs out on `401`
  as notes already do.
- **FR-02 [M]** Participants are shown by **display name only; email addresses never leave the
  server** outside `/api/me`. Display names are 2–32 characters, trimmed, and rendered as text
  (no HTML). The name comes from the Better Auth user record and is editable via Better Auth's
  `update-user` endpoint (no new endpoint); a rename applies to existing shares.
  *Acceptance:* a payload snapshot of positions contains no `@` string; renaming shows in another
  participant's view within one poll.
- **FR-03 [M]** The start flow offers **people from past shares** (last 20 distinct, most recent
  first) so a repeat share is one tap. There is no address-book upload and no contact sync.
  *Acceptance:* after a share with Ana ends, Ana appears in the picker; a user with no history sees
  the create-a-link path instead.

### 6.2 Starting a share

- **FR-04 [M]** Creating a share requires **how long** only: presets **15 / 30 / 60 / 120 minutes**
  or "until I stop" with a hard cap of **8 hours**. The server sets `expiresAt`; the client cannot
  extend it except by creating a new share.
  *Acceptance:* create with each preset → `expiresAt` matches, bounded by server time; "open" gets
  `createdAt + 8h`; a client-supplied huge duration is rejected.
- **FR-05 [M]** Before activation a **consent screen** states, in plain language: who will see, until
  when, what is shared (your location while the share is on, updated about every 10 s), and that it
  can be stopped at any moment. Nothing is created without an explicit tap.
  *Acceptance:* the Start button is the only path; copy is covered by a test that asserts the
  duration and the stop promise are present for each preset.
- **FR-06 [M]** Location permission is requested **at start**, from a user gesture. If denied,
  unavailable or the secure context is missing, the share **still starts in see-only mode**:
  participants see others, and the initiator's own row reads "Your location is off". The UI must
  never claim location is being shared when it is not.
  *Acceptance:* denying the prompt creates the share with the initiator's `sharing=false` and
  renders the "location off" state, with platform-specific help; no ping is sent.
- **FR-07 [M]** Limits: at most **3 active shares per user**, **10 participants per share**, and
  **10 shares created per hour per user**. A rejected create returns a specific error the client
  turns into a sentence ("You already have 3 shares open — end one first").
  *Acceptance:* the 11th participant join → `409 share_full`; the 4th active → `409
  too_many_active_shares`; the 11th create in an hour → `429 rate_limited`.
- **FR-08 [M]** The hub is reachable from every screen's header, and creating a share is at most
  three taps from the hub: **Share** → duration → **Start**. Picking recent people is offered on the
  same screen and creates one link per person (a link is single-use, §6.5).
  *Acceptance:* from `/share`, "Share for 30 minutes" then "Start" is two taps plus the permission
  prompt.

### 6.3 Publishing your location

- **FR-09 [M]** While the app is **visible** and the share is active, the client watches position
  (`enableHighAccuracy: true`, `maximumAge: 5s`, `timeout: 15s`) and publishes at most every
  **10 s**; a move of more than **50 m** publishes immediately (subject to the server minimum). The
  server rejects pings closer than **5 s** apart with `429`, which the client treats as normal, not
  an error.
  *Acceptance:* a simulated fast-moving watcher produces pings no more often than every 5 s
  server-side; a stationary one produces ≤ 6 pings/min.
- **FR-10 [M]** The ping payload is `{ lat, lng, accuracy }`; the **session user's id comes from the
  cookie, never the body**. The server validates lat ∈ [-90, 90], lng ∈ [-180, 180], accuracy ∈
  [0, 100000] metres, rounds coordinates to 6 decimal places (~11 cm), and stamps `lastAt` with the
  **server clock** (a client timestamp is ignored, so freshness cannot be forged).
  *Acceptance:* an out-of-range ping → `400`; a ping carrying another user's id in the body cannot
  write that user's row; a back-dated timestamp does not make a position look fresher.
- **FR-11 [M]** While the share screen is visible and the user is publishing, the app requests a
  **screen wake lock** and re-requests it after every visibility change. Where the API is absent,
  the screen says "Keep this screen open — updates stop if the phone locks".
  *Acceptance:* `navigator.wakeLock` is feature-detected; hide then show re-acquires; pausing or
  ending releases it.
- **FR-12 [M]** Publishing **stops when the page is hidden** (screen locked, app backgrounded) and
  resumes, with an immediate ping, when visible again. The app tells the user this before they
  rely on it, and the recipient's UI shows the consequence (§6.4, FR-20).
  *Acceptance:* a `visibilitychange` to hidden stops the watcher and the interval; no pings arrive
  from a hidden page (covered by a client unit test around the hook).
- **FR-13 [M]** **Pause** ("Stop sharing my location") is one tap, needs no confirmation, and
  clears the published position server-side in the same request, so other participants see
  "Paused", not a stale pin. Resuming asks for permission again only if permission was lost.
  *Acceptance:* after pause, other clients' next payload has `sharing:false` and `lastAt:null`, and
  the map removes the marker.
- **FR-14 [S]** Only one tab/window publishes per account (Web Locks where available, a
  `localStorage` lease otherwise). Other tabs render normally but say "publishing in another tab".
  *Acceptance:* two tabs; only one sends pings; the second shows the notice and does not fight for
  the watcher.
- **FR-15 [M]** Network failures retry with backoff (2 s, 5 s, 10 s, capped at 60 s) while the
  page is visible; the UI shows the age of the last successful publish. A `409 share_ended` or
  `410`-class response ends publishing immediately and switches the screen to the ended state.
  Pings are never queued across a share's end.
  *Acceptance:* killing the network mid-share pauses publishing, shows the warning, and resumes on
  reconnect; an ended share cannot be resumed by a retrying client.
- **FR-43 [S]** **Adaptive cadence**: while stationary (moved < 10 m in 60 s) publish every 30 s
  instead of 10 s; any movement restores the 10 s schedule immediately. Motion still beats the
  battery, freshness never drops below the NFR-01 target for a moving person.
  *Acceptance:* a stationary simulated watcher produces ≤ 2 pings/min; a moving one returns to the
  10 s cadence within one tick.

### 6.4 Seeing participants

- **FR-16 [M]** The positions payload returns every joined participant:
  `{ userId, displayName, role, sharing, lastAt, lat, lng, accuracy, isYou }`, plus the share's
  `status`, `expiresAt`, and **`serverTime`**. Clients compute ages from `serverTime`, not from the
  device clock, so a phone with the wrong time does not show "last seen in 3 hours".
  *Acceptance:* a payload contains `serverTime`; the client's freshness formatter is unit-tested
  against a skewed clock.
- **FR-17 [M]** Default view is a **list**, not a map: each row shows name, state
  (Live / Stale / Paused / Joined, not sharing / Waiting for first fix), the age of the last
  update, and the accuracy ("±12 m" or "approximate" above 200 m). When the viewer has its own
  position, distance is shown ("about 1.2 km away"). No ETA, no street addresses in v0.
  *Acceptance:* every participant state has a distinct text label, not only a colour.
- **FR-18 [M]** **Map view** is a lazy-loaded chunk (Leaflet + raster tiles bundled locally; no CDN
  scripts), with a marker and an accuracy circle per participant, auto-fitted to the participants.
  Tiles come from a **configurable tile provider**; the list is always present and the map is the
  enhancement, so a tile failure degrades to the list rather than a broken screen. OSM's public
  tiles are for prototyping only — production needs a keyed provider and OSM attribution (see
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)).
  *Acceptance:* the map chunk is not in the initial bundle; no map-related network call happens
  until the map is opened; killing tiles leaves a usable list.
- **FR-19 [M]** **Membership is the read authorisation**: a non-member gets `404` for the share
  summary and for positions, identically to an unknown id. Leaving, being removed or the share
  ending revokes **position** reads immediately (the ended summary remains viewable per FR-32).
  *Acceptance:* a second account is denied `404` on both routes; a removed participant's next
  request → `404`; no endpoint returns coordinates for a share the caller is not joined to.
- **FR-20 [M]** Staleness is explicit: `lastAt` older than **90 s** renders "Last seen 4 min ago —
  their app may be closed or the phone locked", and the marker is de-emphasised. Fresh positions
  (≤ 45 s) render "Live".
  *Acceptance:* fake `lastAt` values at 30 s / 60 s / 91 s produce Live / Live-with-age / Stale
  labels; the threshold is a named constant, not a magic number in JSX.

### 6.5 Invites and joining

- **FR-21 [M]** The owner — and only the owner — can create a **join link**
  `https://<site>/join/<token>`. The token is ≥ 128 bits of randomness, URL-safe, stored **only as a
  SHA-256 hash**, shown exactly once, and is **single-use**: it is consumed by the first accepted
  join. Links expire at the earlier of 24 hours and the share's expiry. Creating a share mints
  one link per intended recipient (up to nine), so a group can be invited without forwarding a
  single link; regenerating a link revokes the share's other unaccepted links.
  *Acceptance:* the raw token is not recoverable from the database; a second account using a
  consumed token → `410 invite_used`; a revoked token → `410 invite_revoked`.
- **FR-22 [M]** The join page works before and after sign-in:
  - signed out: a generic invitation ("You've been invited to a Live Share — sign in to see it"),
    with the link kept through the email-code flow and the user returned to it afterwards;
  - signed in: the inviter's name, the remaining minutes, and the consent copy — "You'll see their
    location and they'll see yours until 18:42. You can leave at any time." — then **Join**.
  *Acceptance:* a signed-out visitor learns nothing about who or where; after sign-in the same
  path previews and joins; the token is stripped from the URL (`history.replaceState`) once joined.
- **FR-23 [M]** The join page loads **no third-party assets** (no fonts, analytics, avatars, map
  tiles), sends `Referrer-Policy: same-origin`, and cache-control is `no-store`, so the token is
  not forwarded or cached by intermediaries.
  *Acceptance:* the page's network log contains only same-origin resources; response headers
  checked.
- **FR-24 [M]** Joining is **idempotent for the same account**: opening one's own consumed link
  lands in the share. A different account on a consumed, expired or revoked link gets a plain
  sentence and is told to ask for a new one — never a silent failure.
  *Acceptance:* tests for same-account re-open (200), other-account reuse (410), expired (410).
- **FR-25 [S]** Email delivery: "Invite by email" sends the same link through the existing Resend
  layer (HTTPS only; Render blocks SMTP), with the share duration and expiry in the message. Email
  is a convenience over the link, not a separate invite mechanism.
  *Acceptance:* an invite email contains the URL and expiry; with no mail configured the UI offers
  copy-link instead (the deployment's mail capability is already exposed by `/api/config`).
- **FR-26 [M]** The copy is honest about the link's nature: *"Anyone with this link can join once.
  Send it to one person."* The native share sheet (`navigator.share`) is offered where available,
  with copy-link fallback.
  *Acceptance:* copy is present; share-API absence falls back without an error.

### 6.6 Roles, leaving, removing

- **FR-27 [M]** **Owner**: creator; can end the share, remove guests, create links. **Guest**: can
  leave, pause/resume sharing. Guests cannot remove others or end the share for everyone.
  *Acceptance:* guest calling `end` → `403 not_owner`; guest calling remove → `403`; owner can do
  both.
- **FR-28 [M]** Leaving or being removed clears that participant's position **at once** and revokes
  their reads; the share continues for the rest. The owner leaving **ends the share** (there is no
  ownerless share; the confirmation says so).
  *Acceptance:* after leave/remove, the participant row is `left`/`removed` with null coordinates;
  an owner-leave ends the share and every client moves to the ended state on its next poll.
- **FR-29 [M]** Every membership change writes a **share event** (`created`, `joined`, `left`,
  `removed`, `paused`, `resumed`, `ended`, `expired`, `invite_created`) with actor and timestamp —
  never coordinates. Events are visible to the owner in the share's detail view ("Ana left ·
  18:31") and retained only as long as the share (§6.7).
  *Acceptance:* a share's event list matches the actions taken; events survive a redeploy (they are
  in Postgres) but are purged with the share.
- **FR-30 [M]** A paused participant remains a member and can see others; their row is "Not
  sharing". Pausing is not leaving; leaving is not ending.

### 6.7 Ending, expiry, and retention

- **FR-31 [M]** A share ends when the owner ends it, the last participant (owner) leaves, or
  `expiresAt` passes — whichever is first. Expiry is enforced **lazily on every read and write**
  (no cron, because the free tier has no scheduler): a share whose `expiresAt <= now()` behaves as
  ended even before any row is updated.
  *Acceptance:* a share with `expiresAt` in the past returns `409 share_ended` on ping, and
  `409`/no coordinates on read; a timer is not required for correctness.
- **FR-32 [M]** Ending clears **all** coordinates on the share's participant rows (`NULL`) and sets
  `status='ended'`, `endedAt`, `endReason`. The share summary (names, timestamps, events) may remain
  visible to its participants for **24 hours**, then purged. A throttled opportunistic sweep (at
  most once per hour, guarded in process memory) deletes old ended shares and events; no cron
  dependency, no unbounded growth.
  *Acceptance:* after end, a query for the share's participant rows shows null coordinates; a
  share older than 24 h is gone after any share-route request; the sweep cannot run twice
  concurrently per instance.
- **FR-33 [M]** Controls: **Pause** is always one tap; **End share** (owner) is always visible with
  a countdown ("Ends in 12:04"), one confirmation, and works from the paused state too. There is no
  screen from which a user cannot stop sharing.
  *Acceptance:* every share screen renders the stop control within the first viewport; ending from
  the map, list, and paused states all work.
- **FR-34 [M]** **No location history exists.** Pings overwrite the participant's coordinates; no
  breadcrumbs, trails, or aggregates are written. Ended rows are purged. Account deletion cascades
  to hosted shares (ended) and memberships (removed), so a deleted user leaves nothing.
  *Acceptance:* schema inspection shows no history table; deleting a user leaves no share rows
  referencing them; the 24 h purge test above.

### 6.8 Failure and degraded modes

- **FR-35 [M]** Geolocation states are modelled explicitly: `unsupported`, `prompt`, `granted`,
  `denied` (persistent) and `unavailable` (no fix). Denied shows platform-appropriate instructions
  and the see-only mode; `unavailable` keeps the share alive with "waiting for a location fix"
  (indoors, GPS off).
  *Acceptance:* each state has a rendered message and no crash; the see-only path still joins and
  receives positions.
- **FR-36 [M]** Offline: the shell and last-rendered state stay; an offline banner says "You're
  offline — your location isn't updating"; on reconnect the screen refetches immediately. The
  share list is cache-first; **positions are not persisted** (NFR-05).
  *Acceptance:* airplane mode toggles the banner and resumes polling; localStorage contains no
  coordinates.
- **FR-37 [M]** A **cold API start** (free tier, up to ~30 s) is a progress state, not an error:
  the first request shows "Starting the server — first request can take up to 30 seconds", retries
  once, and then surfaces a retry button. Never a blank screen, never a fabricated "sent".
  *Acceptance:* with the API stopped, the create flow shows the cold-start state and recovers when
  the request eventually succeeds.
- **FR-38 [M]** Old cached shells: adding the feature must not break a shell that knows nothing
  about it. Routes are additive under `/api/shares`, and the existing stale-build reload makes old
  JavaScript self-heal on the next resume.
  *Acceptance:* an old bundle still signs in and uses notes; the new API routes are never called by
  it.

### 6.9 Limits and abuse

- **FR-39 [M]** Rate limits, enforced in-process (single free instance; documented as
  per-instance): pings ≥ 5 s apart per user per share; positions reads ≥ 1 s apart per user; join
  attempts ≥ 10/min per link; creates ≥ 10/h per user. `429` carries `Retry-After`, and the client
  treats it as expected — no error toast.
  *Acceptance:* a burst of pings produces `429` at the right boundary and no 500s; a test asserts a
  ping exactly at the interval is accepted.
- **FR-40 [M]** Links are bearer secrets: hashed at rest, single-use, revocable by regeneration,
  expiring with the share. A leaked link grants at most one seat in one share until it ends; the
  owner can end the share to revoke it.
  *Acceptance:* regeneration invalidates the previous token; the ended share rejects join attempts
  with `409`/`410`.
- **FR-41 [M]** Position spoofing is accepted and **documented**, matching the leaderboard's
  precedent (`docs/ARCHITECTURE.md` §6): the client is the sensor. The server validates bounds and
  nothing more; no product copy may claim spoofing prevention.
  *Acceptance:* a crafted ping with valid coordinates is stored as sent; the limitations note
  exists in the docs.
- **FR-42 [C]** A user-level block/report mechanism (blocking a link creator from future shares,
  reporting a share) is deferred. Before public launch without an invite-graph, it becomes [M] for
  abuse handling; v0's controls are revoke/end/remove.

---

## 7. Data model

Four new tables, all keyed to the existing `user` table with real foreign keys and cascades, in the
style of `apps/api/src/db/schema.ts`.

### 7.1 `share` — one sharing session

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | random |
| `ownerId` | text → user.id, on delete cascade | who started it |
| `status` | text | `active` \| `ended` |
| `durationMinutes` | integer null | null = "until I stop" |
| `expiresAt` | timestamptz | always set; the server enforces it |
| `endedAt` / `endReason` | timestamptz / text | `manual` \| `expired` \| `owner_left` |
| `createdAt` / `updatedAt` | timestamptz | |

Indexes: `(ownerId, createdAt)` for "my shares"; `(status, expiresAt)` for the lazy-expiry sweep.

### 7.2 `share_participant` — membership + the current position

| Column | Type | Notes |
| --- | --- | --- |
| `shareId` → share, `userId` → user | PK pair | cascade deletes |
| `role` | text | `owner` \| `guest` |
| `state` | text | `joined` \| `left` \| `removed` |
| `sharing` | boolean, default **false** | explicit opt-in; flips on permission grant |
| `lastLat`, `lastLng`, `lastAccuracy` | double precision null | the **only** stored position |
| `lastAt` | timestamptz null | server clock |
| `joinedAt` / `updatedAt` | timestamptz | |

Indexes: `(shareId)` (PK prefix covers it), `(userId, joinedAt)` for "recent people". `sharing`
defaults to false: joining is not publishing, and publishing is a separate, permission-gated
action.

### 7.3 `share_invite` — single-use links

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `shareId` → share cascade, `createdBy` → user cascade | | |
| `tokenHash` | text unique | SHA-256 of the raw token; raw is never stored |
| `expiresAt` | timestamptz | min(now + 24 h, share.expiresAt) |
| `acceptedBy` / `acceptedAt` | text → user null / timestamptz null | first accepted join |
| `revokedAt` | timestamptz null | set when the owner regenerates |

### 7.4 `share_event` — audit of membership changes, never positions

`id`, `shareId` (cascade), `actorId` (null = system expiry), `kind` (`created` | `joined` | `left` |
`removed` | `paused` | `resumed` | `ended` | `expired` | `invite_created`), `createdAt`.
Index `(shareId, createdAt)`.

### 7.5 Invariants (the tests encode these)

1. A position write requires `share.status='active' AND share.expiresAt > now() AND
   participant.state='joined' AND participant.sharing=true`, in the same statement that authorises
   by the session user — no fetch-then-check.
2. Reads require the caller's participant row to be `joined` and the share `active`; anything else
   is `404`/`409` with the same body a stranger sees.
3. Every transition out of `sharing`, out of `joined`, or out of `active` clears the coordinates in
   the same transaction (pause, leave, remove, end, expire).
4. `lastAt` is server-assigned; clients cannot set it.
5. `tokenHash` is unique; the raw token exists only in the owner's create response and the URL.
6. Expiry is derived from `expiresAt` at read time, so an unswept row can never serve coordinates.
7. The owner is always a `role='owner'` participant, created in the same transaction as the share.
8. No row outside this model stores coordinates or aggregates of them.

---

## 8. API contract

All under the existing session gate. All responses `Cache-Control: no-store`. Bodies validated with
`zValidator` at the route (the precedent in `notes.ts`), so the PWA's `hc<AppType>` client is typed
against them.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/shares` | session | My shares: active first, then ended within 24 h. No coordinates. |
| `POST` | `/api/shares` | session | Create `{ durationMinutes: 15\|30\|60\|120\|null, inviteCount?: 1–9 }` → share + one single-use link per recipient. |
| `GET` | `/api/shares/join-preview?token=…` | session | Pre-join preview: inviter's name, remaining minutes, or `alreadyMember` with the share; `410` for a dead link. |
| `GET` | `/api/shares/:id` | member | Summary: status, expiry, participants (names/roles/states), events (owner), `serverTime`. |
| `GET` | `/api/shares/:id/positions` | member | Positions payload (below). |
| `POST` | `/api/shares/:id/positions` | member, sharing | Publish `{lat, lng, accuracy}`; response **is** the positions payload, so one request covers send + receive. |
| `PATCH` | `/api/shares/:id/me` | member | `{ sharing: boolean }` — pause/resume; clears or re-enables publishing. |
| `POST` | `/api/shares/:id/end` | owner | End for everyone. |
| `POST` | `/api/shares/:id/leave` | member | Guest leaves; owner leaving ends the share. |
| `POST` | `/api/shares/:id/invites` | owner | New single-use link (v1: optionally emailed to an address); revokes the previous unaccepted one. |
| `POST` | `/api/shares/:id/participants/:userId/remove` | owner | Remove a guest. |
| `POST` | `/api/shares/join` | session | `{ token }` → join; idempotent for the same account. |
| `GET` | `/api/people/recent` | session | Last 20 co-participants for the picker. |

### 8.1 Positions payload (the one shape everything shares)

```json
{
  "share": {
    "id": "…", "status": "active", "expiresAt": "2026-11-19T18:42:00.000Z",
    "endedAt": null, "endReason": null, "serverTime": "2026-11-19T18:11:03.412Z"
  },
  "participants": [
    { "userId": "…", "displayName": "Ana", "role": "guest", "sharing": true,
      "lastAt": "2026-11-19T18:11:01.000Z", "lat": 51.5074, "lng": -0.1278,
      "accuracy": 12.5, "isYou": false }
  ]
}
```

Rules: `serverTime` is always present (freshness is computed against it); `lastAt`, `lat`, `lng` and
`accuracy` are `null` together for anyone with no current position (paused, or waiting for a first
fix); the viewer's own row is marked `isYou`; coordinates are the only place latitude/longitude ever
appear in a response.

### 8.2 Errors

| Status | Codes | Meaning |
| --- | --- | --- |
| 400 | `invalid_body`, `invalid_id` | Zod rejected the payload, with issues (never echoed coordinates). |
| 401 | `unauthorized` | No session. |
| 403 | `not_owner` | A membership-scoped action by a non-owner. Only for callers who already see the share. |
| 404 | `share_not_found`, `invite_not_found`, `participant_not_found` | Unknown id **or** a non-member — deliberately indistinguishable. |
| 409 | `share_ended`, `share_full`, `too_many_active_shares`, `not_sharing` | State conflicts, including a ping from a paused participant. |
| 410 | `invite_expired`, `invite_used`, `invite_revoked` | Dead link, with a sentence in the UI. |
| 429 | `rate_limited` (plus `Retry-After`) | The client's normal cadence boundary. |

### 8.3 Delivery: polling now, streaming later

v0 uses **polling**, not SSE/WebSocket: a long-lived connection on a 0.1-CPU instance that sleeps is
a reconnect-storm risk, and polling is trivially correct on a phone that loses radio constantly.

- Publishing client: `POST positions` every 10 s while visible (response carries the others' state).
- View-only client: `GET positions` every 10 s while visible.
- Hidden: no polling. Visible again: immediate refetch.
- One request in flight at a time; failures back off 2 → 5 → 10 → 20 → 60 s.

A future `GET /api/shares/:id/events` (`text/event-stream`, identical payload, 25 s keepalive) can
replace polling without changing the payload contract; it is out of v0 for the reason above.

---

## 9. UX: flows, screens, states, copy

### 9.1 Flow A — the initiator

```
Hub (/share) ──[ Share location ]──▶ New share
                                       ├─ how long: 15m · 30m · 1h · 2h · until I stop (8h cap)
                                       ├─ who (optional): recent people → one link each
                                       └─ consent card ──[ Start ]
                                             │  geolocation permission
                                    granted ─┤──────────────▶ /share/:id  "Live · updating every 10s
                                    denied  ─┘                 · until 18:42"  [map | list]
                                     └▶ /share/:id "Your location is off — here's how to enable"
                                        (see-only; participants' rows still update)
```

### 9.2 Flow B — the recipient

```
/join/<token>
   ├─ signed out ─▶ "You're invited to a Live Share. Sign in to see who and join."
   │                    email code ─▶ back to /join/<token> (token preserved)
   └─ signed in  ─▶ inviter name · "until 18:12" · "You'll see their location and they'll see
                      yours. Leave any time."  ──[ Join ]
                        ├─ join ok ─▶ permission prompt ─▶ /share/:id live
                        └─ 410      ─▶ "This link was already used or has expired. Ask for a new one."
```

### 9.3 Flow C — stopping

```
/share/:id ──[ Pause my location ]──▶ row = "Not sharing"; others see "Paused"
          ──[ End share ]──▶ one confirmation ─▶ "Share ended at 18:42. Locations are no longer visible."
          guest ──[ Leave ]──▶ removed from the share; owner sees "Ana left · 18:31"
```

### 9.4 Screens

| Route | Screen | Contents |
| --- | --- | --- |
| `/share` | Hub | Active shares as cards (countdown, people, state), "Share location" primary action, recent people, a short "how it works, and what it doesn't do" line. |
| `/share/new` | New share | Duration presets, recent-people chips (each creates a link), consent card, Start. |
| `/share/:id` | Active share | Map/list toggle, participant rows, countdown, pause/end (or leave), link management ("Invite someone"), wake-lock hint. |
| `/share/:id/ended` | Ended | "Ended at 18:42" summary, event list for the owner, "Share again". |
| `/join/:token` | Join | Signed-out invite, signed-in preview, consent, Join. Also the 410 states. |
| `/profile` (sheet) | Profile | Editable display name (Better Auth `update-user`), sign out. |

Header gains one persistent entry point so the feature is not hidden behind notes or games.

### 9.5 Participant state model (the sentences that must exist)

| Server state | Label to others | Marker |
| --- | --- | --- |
| `sharing`, `lastAt` ≤ 45 s | Live · 8 s ago | normal |
| `sharing`, `lastAt` 46–90 s | Live · 1 min ago | slightly faded |
| `sharing`, `lastAt` > 90 s | Last seen 4 min ago — app may be closed | faint / outline |
| `sharing=false` | Not sharing / paused | no marker |
| `joined`, no fix yet | Waiting for a location fix | spinner dot |
| `left` / `removed` | (hidden from positions) | absent |
| share ended | "This share has ended" | whole screen |

### 9.6 Copy and honesty rules

- The start card says **who**, **until when**, and **what is shared** — in that order.
- Never say "Location shared" before a first successful ping; show "Waiting for your first
  location fix" and the see-only state when permission is denied.
- Say "keep this screen open" and *why*, once, before the user relies on it.
- The stop control's label is an action ("End share"), not a setting ("Sharing: on").
- No dark patterns: no pre-checked boxes for recipients, no auto-restart.

### 9.7 Accessibility and touch

- List-first; the map is an enhancement. Status has text, never colour alone.
- 44×44 px targets, `:focus-visible` outlines, reduced-motion guards (existing CSS conventions).
- Screen-reader: countdown and "last seen" announce meaningful changes, not every poll tick.
- No pinch-only interactions for anything essential.

---

## 10. Non-functional requirements

| ID | Requirement | Target / verification |
| --- | --- | --- |
| NFR-01 | **Freshness**: foreground positions are at most 15 s old typically; staleness is visible with a 90 s threshold. | Payload ages observed in two-phone test; unit tests on the formatter. |
| NFR-02 | **Battery and data discipline**: ≤ 1 ping/5 s, none while hidden, no polling while hidden; positions in responses < 2 KB. | Client hook tests; payload size assertion. |
| NFR-03 | **Scale and cost**: 10 participants per share, 3 active shares per user; no new Render resources, no server-side map work, no new credentials; a tile provider is external and optional at runtime. | Blueprint unchanged; load sanity with 10 polling clients. |
| NFR-04 | **Security**: membership is a `WHERE` clause (404 policy); tokens hashed and single-use; coordinates never in logs; error bodies never echo coordinates; `no-store` on share responses. | Integration tests; log inspection. |
| NFR-05 | **Privacy**: per-session consent; no history; positions never persisted client-side (the persisted query cache must **exclude** share/position keys — `shouldDehydrateQuery` allowlist in `main.tsx`); retention purge ≤ 24 h; no third-party analytics. | localStorage inspection after a share; purge test. |
| NFR-06 | **Accessibility**: every state label exists in text; interactive controls labelled; WCAG 2.2 AA contrast for status chips. | Manual audit; the existing Lighthouse checklist. |
| NFR-07 | **Observability**: counts for shares created, joins by outcome (ok / used / expired), pings accepted vs rate-limited, ends by reason — emitted without coordinates; the existing RSS heartbeat stays the early warning. | Log inspection; no PII in logs. |
| NFR-08 | **Portability**: geolocation, wake lock and visibility handling isolated in `lib/location.ts` so a native shell can replace them; the API knows nothing about browsers. | Code review; no DOM assumptions in the data layer. |
| NFR-09 | **Resilience**: no correctness dependency on timers or cron; lazy expiry + opportunistic sweep; cold start is a UI state, not an error. | Tests with `expiresAt` in the past and the API restarting. |

---

## 11. Verification plan

### 11.1 Automated (must pass before merge)

Integration tests in `apps/api` (PGlite + real Better Auth, following `app.test.ts`):

1. Every share route is `401` without a cookie.
2. Create → a participant row exists for the owner and a single invite link is returned.
3. Cross-user isolation: a non-member gets `404` on summary and positions; a guest cannot end or
   remove.
4. Join: a valid token joins; a second account on the same token gets `410`; the same account
   re-opening its link is idempotent.
5. Pause clears coordinates in the same response; resume re-enables pings.
6. End (owner) clears all coordinates, ends the share, and pings are rejected with `409`.
7. Expiry: a share with `expiresAt` in the past rejects pings and returns no coordinates without
   any sweep having run.
8. Leaving/being removed revokes positions reads immediately.
9. Limits: participant cap `409`, create-rate `429`, ping throttle `429`.
10. Purge: a 25-hour-old ended share is deleted after any share-route request.
11. No response contains an email address (snapshot the positions payload).
12. Account deletion cascades: hosted shares are gone, memberships are gone.

Unit tests (dependency-free, no DOM):

- token hashing (raw never equals stored; verification works);
- freshness formatter with a skewed server/client clock;
- distance/bearing helper;
- the publishing hook's visibility gating and single-in-flight guard (with a fake geolocation and
  fake timers).

### 11.2 Field protocol (needs ≥ 2 real phones on the deployed HTTPS site)

Because this device has no browser, these are manual and must be recorded as such:

1. Permission denied → see-only mode, clear help text, no pings in the DB.
2. Screen lock → after 90 s the other phone shows "Last seen…"; unlock → "Live" again.
3. Wake lock holds the screen awake for 20 minutes on iOS and Android; battery delta recorded.
4. Map renders, markers move, accuracy circles behave; tiles can be blocked → list still works.
5. In-app browser (WhatsApp/Instagram link preview) → sign-in works, join completes.
6. Airplane mode mid-share → warning shown; turning it back on resumes.
7. End on phone A → phone B's next poll shows the ended state and no markers.
8. Cold API start after 20 min idle → create flow recovers with the progress state.
9. Two tabs → one publisher; the second shows the notice.
10. Accessibility pass: VoiceOver/TalkBack on the join and active screens.

### 11.3 Cannot be verified on the build machine

Geolocation, wake lock, real map rendering, battery drain and real-device layout are **unverified**
here by definition. Report them as prompts for the field protocol, never as passes.

---

## 12. Risks

| # | Risk | L | Mitigation |
| --- | --- | --- | --- |
| R1 | Users expect Life360 parity ("why does it stop when I lock my phone?"). | High | Name/onboarding copy states the ceiling; the stale label explains it; the native shell is the upgrade path (§4.1 G6). |
| R2 | iOS suspends the page quickly, so shares die in a bag. | High | Wake lock + explicit hint + honest "last seen"; never claim background reliability. |
| R3 | A leaked link lets the wrong person in. | Medium | Single-use, expiry ≤ 24 h, revocable by regenerating the link or ending the share; owner can remove; copy warns "send to one person". |
| R4 | Coercion: someone pressured into a share, or a link forwarded as surveillance. | Medium–High | Per-session consent wording, mutual visibility, one-tap pause always present, owner remove, owner end; block/report is a pre-public-launch gate (FR-42). |
| R5 | Spoofed coordinates presented as truth. | Low–Medium | Accepted and documented; no anti-spoofing claims; the audience is people who already know each other, so a dot is a convenience, never a safety authority. |
| R6 | Cold start stalls the first interaction (up to ~30 s). | Medium | Progress + retry UI; move the API to the paid instance for real users (existing runbook). |
| R7 | Public OSM tiles are not a production plan. | Medium | Keyed tile provider before real users; list fallback; no CDN scripts. |
| R8 | Free Postgres expiry deletes data. | High (ops) | Shares are ephemeral by design; the same runbook upgrade applies before real users. |
| R9 | Position data leaks into logs or the localStorage cache. | Medium | No coordinate logging; persisted-cache allowlist; `no-store`; tests. |
| R10 | Battery drain / indoor fixes make accuracy poor indoors. | Medium | 10 s cadence, accuracy display, "approximate" over 200 m, adaptive cadence in v1. |
| R11 | A participant's display name is used to impersonate. | Low | Name is advisory; the join page shows the owner and the link's provenance; no email exposure. |
| R12 | Two publishers (two tabs) double the GPS load and write churn. | Low | v1 single-publisher lease (§6.3 FR-14). |

---

## 13. Decisions (locked 2026-11-21)

All ten were confirmed against the recommendations below, so the v0 scope in §5, the requirements in
§6, the data model in §7 and the contract in §8 are consequences rather than proposals. D1, D4, D5
and D3 were the four explicitly put to review; the rest were locked by the same rule — adopt the
recommendation unless something in the repo contradicts it, in which case the doc records why.

| # | Decision | Resolution (locked) | Why | Alternative considered |
| --- | --- | --- | --- | --- |
| D1 | Invite mechanism | **Single-use link**, sent by copy, native share sheet, or email (v1) | Works without a contact graph; the link is the consent object; fits the existing email-code sign-in. | Email-first invites with a pending row. |
| D2 | Visibility model | **Mutual**: everyone in a share sees everyone | Consent story is simpler; no asymmetric surveillance. | Owner sees guests; guests cannot see each other. |
| D3 | History | **None in v0**; positions are overwritten and purged | The privacy promise is the feature; history needs its own consent and retention design. | 24 h trail, per-share. |
| D4 | Duration | Presets **15 / 30 / 60 / 120 min** + "until I stop", hard cap **8 h** | Bounded sessions protect privacy and make expiry testable; open-ended sharing drifts into tracking. | Free-form end time. |
| D5 | Map | **v0**, lazy-loaded Leaflet raster; **keyed tile provider in production**, list fallback | A location app without a map feels incomplete; Leaflet is small and lazy-loadable. | List-only v0; MapLibre/WebGL. |
| D6 | Transport | **Polling at 10 s**; SSE later, same payload contract | Long-lived connections on a sleeping 0.1-CPU instance are an operational risk. | SSE/WebSocket from the start. |
| D7 | Publishing opt-in | **Default off**; an explicit permission grant flips `sharing=true` | Joining ≠ publishing; the database reflects exactly what was consented to. | Implicit sharing on join. |
| D8 | Who may invite | **Owner only** | One clear authority per share; guests are participants, not recruiters. | Any member. |
| D9 | Guests without accounts | **No** in v0 — joining requires a signed-in account | Identity is the consent subject; anonymous links break "who is in this share". | Anonymous viewer tokens. |
| D10 | Reporting/block | **v1 gate before public launch** | The v0 audience is an invite graph, but abuse needs a control before the doors open. | Ship without it, accept the risk. |

---

## 14. Implementation sketch in this repo

| Area | Where | Notes |
| --- | --- | --- |
| Schema | `apps/api/src/db/schema.ts` | Four tables + relations; invariants in §7.5. |
| Migration | `apps/api/drizzle/0004_*.sql` (generated, reviewed) | `pnpm --filter @portal/api db:generate`; snapshot committed. |
| Routes | `apps/api/src/routes/shares.ts` | `Hono<AppEnv>` + `zValidator` like `notes.ts`; membership helper returns `404`; lazy expiry helper; purge sweep (module-level throttle). |
| Limits | `apps/api/src/limits.ts` (new) | In-process token buckets; `429` + `Retry-After`; document the per-instance caveat. |
| Mount | `apps/api/src/app.ts` | `.route("/api/shares", sharesRoutes)`; `/api/*` gate already applies. |
| Types | `apps/api/src/index.ts` | Export `Share`, `ShareParticipant`, payload types for `hc<AppType>`. |
| Tests | `apps/api/src/shares.test.ts` | Same PGlite + real-auth boot as `app.test.ts` (§11.1). |
| Location | `apps/pwa/src/lib/location.ts` (new) | Geofix wrapper: watch/stop, adaptive cadence, wake lock, visibility; no React, testable. |
| Share client | `apps/pwa/src/lib/shares.ts` (new) | Calls, polling hook, error mapping to sentences. |
| Screens | `apps/pwa/src/screens/ShareHubScreen.tsx`, `NewShareScreen.tsx`, `ActiveShareScreen.tsx` (map lazy chunk `components/ShareMap.tsx`), `JoinShareScreen.tsx` | Additive routes in `App.tsx`: `/share`, `/share/new`, `/share/:id`, `/join/:token`. |
| Cache | `apps/pwa/src/main.tsx` + `lib/query.ts` | `shouldDehydrateQuery` allowlist: notes/scores persist; share/positions keys never do; bump `buster`. |
| Styles | `apps/pwa/src/styles.css` | Reuse existing tokens; status chips, map container, countdown. |
| Docs | this file + `docs/ARCHITECTURE.md` §6/§7 | Record the no-history decision and the freshness contract where the next author will look. |

**Acceptance of this document** means the v0 column of §5 is buildable as written: 43 numbered
requirements in §6, four tables in §7, the contract in §8, and the tests in §11.1.

---

## 15. Implementation status (v0)

Built against §5's M column: `apps/api/src/routes/shares.ts` (all routes above), four tables in
`apps/api/src/db/schema.ts` with migration `0004`, `apps/api/src/limits.ts`, and the PWA screens
`ShareHubScreen`, `NewShareScreen`, `ActiveShareScreen`, `JoinShareScreen` plus `lib/location.ts`
(geolocation + wake lock + publishing loop), `lib/shares.ts` (typed client), `lib/geo.ts` (freshness,
distance, countdown) and the lazy `ShareMap` chunk.

**Verified here:** `pnpm test` — 57 API integration tests (23 of them Live Share: single-use links,
404 isolation, pause clearing coordinates, server-stamped positions, the 5 s ping floor, lazy expiry,
the 24 h purge, the participant cap, the create-rate limit, payload privacy, account-deletion
cascades) and 106 PWA unit tests including the freshness formatter against a skewed clock. Typecheck
and the production build pass; the map chunk is 44 KB gzipped and stays out of the initial bundle.
The persisted query cache excludes share/position keys, so a live position is never written to
`localStorage`.

**Deployment detail worth knowing:** `render.yaml` previously sent
`Permissions-Policy: geolocation=()` on every static-site response. That header makes a browser refuse
the geolocation prompt — the feature would have appeared broken only in production. It now reads
`geolocation=(self)`, and `/join/*` responses are `no-store` with `Referrer-Policy: same-origin` so
the token in the URL never travels.

**Not verified here:** anything that needs a real browser and two phones — geolocation permission
flows, the wake lock holding the screen awake, Leaflet rendering and tiles, battery drain, and how
the screens look. Follow §11.2 on the deployed HTTPS site; a LAN IP cannot prompt for location.
