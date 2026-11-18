# Architecture — Portal: a mobile PWA on Render

Status: **proposal, with a working vertical slice behind it**
Scope: one codebase, phone-first UX, email-code sign-in, one persisted resource.
Audience: whoever has to build, operate, and pay for this.

---

## 1. The decision in one page

| Question | Decision |
| --- | --- |
| How do users get the app? | A **PWA** — one responsive web app, installed to the home screen on iOS and Android. No app store, no native binaries. |
| What does Render host? | Three resources: a **static site** (the app), a **web service** (the API), a **Render Postgres** database. |
| Language / framework | **TypeScript everywhere**: React 19 + Vite 8 for the client, **Hono** on Node for the API, **Drizzle** for SQL. |
| Authentication | **Better Auth** with the **email-OTP** plugin. Six-digit code, no passwords, no OAuth. |
| Persistence | **Postgres** (Render-managed in production, embedded PGlite in development) with SQL migrations. |
| Cost | **$0** to prototype; **~$13/month** for a deployment you would let real users touch. |

The important consequence: **there is no app binary**. "Shipping" is a `git push`, and every user is on the new version within one launch. The price of that is a ceiling on some native capabilities — enumerated honestly in §8.

---

## 2. Why a PWA on Render, and what it costs

A PWA is the right call when the product is a form-and-list application rather than something that needs the camera, Bluetooth, background location, or a guaranteed push channel. You get:

- **No review latency.** No App Store review, no Play Store staged rollout. Feature on Tuesday, live on Tuesday.
- **No install friction.** One tap from a link to the home screen, versus a store page and a 50 MB download.
- **One codebase, both platforms, plus desktop.** No Android/iOS divergence, no separate design language for each.
- **Render's static-site tier is free and global-CDN.** The app shell costs nothing to serve and never cold-starts.
- **It is genuinely fast.** This slice ships 97 KB of gzipped JavaScript — a native shell of comparable surface area is not smaller in wall-clock terms on a cold launch.

What you give up, concretely:

1. **No App Store presence.** For a consumer product, store search is a real acquisition channel. A PWA gets none of it.
2. **iOS push requires installation.** Web Push exists on iOS 16.4+, but only for apps the user added to the home screen, and only after a tap. You cannot rely on push for re-engagement.
3. **iOS storage can be evicted.** Safari clears script-writable storage (IndexedDB, localStorage) for sites not added to the home screen after about seven days of non-use. So the local cache is an *accelerator*, never the source of truth.
4. **No email-OTP autofill.** The `one-time-code` autofill affordance is SMS-oriented. A code that arrives by email usually means a trip to the Mail app. The sign-in flow is designed around that (§7).
5. **Some platform chrome is unreachable** — no control over the splash screen on iOS, no true background tasks, and a hard refresh is always one gesture away.

These are acceptable for a portal-class product and unacceptable for, say, a camera-first app. That is the actual decision being made here.

---

## 3. Stack

| Layer | Choice | Version | Why this and not the alternative |
| --- | --- | --- | --- |
| Client | React + Vite | 19.3 / 8.3 | Vite's dev server is instant and its production output is a plain static bundle — exactly what a static site wants. Next.js would drag in a server rendering mode that Render would then have to run, defeating the free static tier. |
| Language | TypeScript | 5.9 | Shared types from database row to React prop. This is the main reason the stack is not, say, Go + React. |
| API | Hono on Node | 4.13 | ~15 KB, Web-standard `Request`/`Response`, and a **typed RPC client** (`hc<AppType>`) so the app's API calls are type-checked against the server's routes with no schema generation step. Express gives none of that; Fastify needs extra machinery. |
| Validation | Zod + `@hono/zod-validator` | 4.6 / 0.9 | One schema per route does double duty: runtime rejection *and* the request-body type the client sees. |
| Database | Postgres (Render) / PGlite (dev) | 18 | Real relational semantics, real migrations, and `PGlite` gives every developer a genuine Postgres 18 in-process with no install. |
| Query builder | Drizzle ORM | 0.45 | SQL-shaped, fully typed, generates plain `.sql` migrations you can read and review. Prisma's engine binary is a poor fit for Termux/ARM development and its generated client is a heavier abstraction. |
| Auth | Better Auth + email-OTP | 1.7 | Sessions, code hashing, attempt limits, expiry, cookie handling, and a React client. Rolling this by hand is ~200 lines of security-critical code; a managed provider (Clerk, Supabase) adds per-MAU cost and a second user store. |
| Email | Resend HTTP API | — | HTTPS, so it works on Render. See §8 for why SMTP is not an option. |
| State | TanStack Query + localStorage persister | 5.108 | Cache-first reads with optimistic writes, and the persisted cache is what makes an offline launch show data instead of a spinner. |

### Repository layout

```
portal-app/
├── apps/
│   ├── api/                    # Hono service → Render web service
│   │   ├── src/
│   │   │   ├── app.ts          # routes, auth gate, exported AppType
│   │   │   ├── auth.ts         # Better Auth + emailOTP configuration
│   │   │   ├── mail.ts         # Resend HTTP client + dev console fallback
│   │   │   ├── routes/notes.ts # the one persisted resource
│   │   │   └── db/             # schema, dual-driver client, migrations
│   │   ├── drizzle/            # generated .sql migrations (reviewed, in git)
│   │   └── src/app.test.ts     # 9 integration tests over the real stack
│   └── pwa/                    # React app → Render static site
│       ├── public/             # manifest, hand-generated icons, service worker
│       ├── scripts/gen-icons.mjs
│       └── src/
│           ├── screens/        # SignInScreen, NotesScreen
│           ├── components/     # CodeInput, InstallPrompt
│           └── lib/            # typed RPC client, auth client, query setup
├── docs/ARCHITECTURE.md
├── render.yaml                 # all three Render resources, as code
└── package.json                # pnpm workspace root
```

---

## 4. Request path

```
┌─────────────────────────┐
│ Phone (Safari / Chrome) │
│ installed PWA           │
└───────────┬─────────────┘
            │  GET /                     → app shell from Render's CDN
            │  GET /api/notes            → proxied by the static site
            ▼
┌────────────────────────────┐        ┌──────────────────────────┐
│ Render Static Site (free)  │───────▶│ Render Web Service       │
│ - serves dist/ from the CDN│ rewrite│ - Hono on Node           │
│ - /api/* → api host        │        │ - Better Auth + routes   │
│ - /* → /index.html (SPA)   │        │ - Drizzle + migrations   │
└────────────────────────────┘        └────────────┬─────────────┘
                                                   │ private network
                                                   ▼
                                      ┌──────────────────────────┐
                                      │ Render Postgres          │
                                      │ user, session, account,  │
                                      │ verification, note       │
                                      └──────────────────────────┘
                                                   │
                                      outbound HTTPS only
                                                   ▼
                                            Resend /emails
```

**The `/api/*` rewrite is the load-bearing detail.** Because the browser only ever talks to its own origin, the session cookie is **first-party**. That removes an entire class of failure: no CORS preflights, no `SameSite=None`, no third-party cookie blocking, no `credentials: 'include'` debugging. The same shape is reproduced in development by Vite's proxy, so local and production behave identically.

✅ **Confirmed on a live deployment.** `POST /api/auth/email-otp/send-verification-otp` through the static site's origin returned `200 {"success":true}` with the JSON body intact, and the session cookie came back `HttpOnly; Secure; SameSite=Lax` on the *static site's* host — first-party, as designed. Had it failed, the fallback would be calling the API host directly with `credentials: 'include'`, `SameSite=None; Secure` cookies, and `TRUSTED_ORIGINS` set to the static site's origin; the API already supports that (`cors()` with credentials plus `trustedOrigins`).

---

## 5. Authentication: a code sent to an email address

### The flow

```
user                     PWA                        API                     email
 │  type email             │                          │                        │
 ├────────────────────────▶│ POST /api/auth/           │                        │
 │                         │      email-otp/send-…     │                        │
 │                         ├─────────────────────────▶│ generate 6-digit code  │
 │                         │                          │ HASH it, store w/ TTL  │
 │                         │                          ├───────────────────────▶│
 │                         │ 200 {success:true}       │                        │
 │◀────────────────────────┤◀─────────────────────────┤                        │
 │  switch apps, read code │                          │                        │
 │  type 6 digits          │                          │                        │
 ├────────────────────────▶│ POST /api/auth/           │                        │
 │                         │      sign-in/email-otp    │                        │
 │                         ├─────────────────────────▶│ verify hash, attempts  │
 │                         │                          │ create user if new     │
 │                         │ 200 + Set-Cookie         │ create session (30d)   │
 │◀────────────────────────┤◀─────────────────────────┤                        │
 │                         │ GET /api/notes (cookie)  │                        │
```

### The decisions inside it

| Setting | Value | Reasoning |
| --- | --- | --- |
| Code length | 6 digits | Fits the standard one-time-code UI; with hashing + attempt limits, 6 digits is defensible. |
| Expiry | **10 minutes** | The library default is 5. A user has to leave the app, open Mail, and come back; 5 minutes produces false "it expired" failures. |
| Storage | **hashed** | A database leak must not hand over live sign-in codes. This is a one-word config change from the `plain` default and it is the single most important line in `auth.ts`. |
| Attempts | 3 per code | Combined with expiry, brute force is infeasible. |
| Resend | 3 per 60s per address | Plus a client-side 60s countdown so the limit is never felt as an error. |
| New users | created on first successful code | No separate signup flow. The first code *is* registration — which is why `displayNameFromEmail()` exists instead of a name field. |
| Sessions | **90 days**, refreshed weekly while in use, cookie cache 5 min | The user should stop seeing this screen. Absolute expiry only bites after three months of inactivity. Accepted tradeoff: a stolen cookie lives up to 90 days; sign-out revokes server-side, effective within ~5 min. |
| Passwords | **disabled** | `emailAndPassword: { enabled: false }`. The credential surface is exactly one path. |

Also deliberate: the send-code endpoint returns `{success:true}` whether or not the address has an account. The integration test asserts this. It removes an account-enumeration oracle at no UX cost — the user learns everything from the email arriving.

### Threat model notes

- **Codes are single-use** and consumed on success.
- **Attempts are capped** server-side, not just in the UI.
- **Rate limiting** is per-address (3/60s) on top of Better Auth's global limiter — this is what stops an attacker using the endpoint as a free email cannon.
- **Session cookies** are `httpOnly`, `Secure` in production, `SameSite=Lax` — correct and maximally compatible precisely *because* the API is same-origin.
- **Authorization is a `WHERE` clause.** Every note query filters on `userId`, so a wrong or guessed id returns 404 rather than someone else's row. There is no "fetch then check" path to forget.
- **`BETTER_AUTH_SECRET` is required** when `NODE_ENV=production`; boot fails loudly without it rather than signing cookies with a dev constant.

---

## 6. Persistence

```sql
user          (id, email UNIQUE, name, emailVerified, …)     -- Better Auth
session       (id, token UNIQUE, userId→user, expiresAt, …)  -- Better Auth
account       (id, providerId, accountId, userId→user, …)    -- Better Auth
verification  (id, identifier, value, expiresAt, …)          -- the OTPs
note          (id uuid, userId→user, title, body, createdAt, updatedAt)
```

**Own the user table.** Using Better Auth's Drizzle adapter means the auth tables live in *this* database, next to application data, joined by real foreign keys. There is no vendor API between the app and who its users are; leaving a managed provider later would be a migration, not an archaeology project.

**Migrations are reviewed SQL in git.** `drizzle-kit generate` emits plain `.sql` from the typed schema; those files are committed, so schema changes show up in code review and production changes are never a surprise `db push`.

**Two drivers, one schema.** `DATABASE_URL` unset → embedded **PGlite**, a real Postgres 18 compiled to WebAssembly, persisted under `apps/api/.pglite`. Set → `node-postgres` against Render Postgres. Both run the same migration files. This is why `pnpm dev` works on a fresh machine with no database installed and no cloud account, and why local dev cannot silently diverge in dialect or SQL semantics.

**Deletes cascade.** Removing a user removes their sessions and notes — `onDelete: "cascade"` in the schema, so an account deletion is one statement rather than a cleanup job.

**What the client caches, and what it does not.** TanStack Query persists the notes list to `localStorage` for offline reads. It is a cache with a `buster` version, never the source of truth — which matters because iOS may evict it (§8).

---

## 7. UX architecture — what actually makes it feel like an app

The gap between "a website that works on a phone" and "an app" is mostly a list of details that are individually small and collectively decisive.

**Sign-in**

- **One field, one question.** Email → code. No password, no name, no terms checkbox in the way.
- **Auto-submit on the sixth digit.** The user never reaches for a button.
- **A single real `<input>`, invisibly stretched over six drawn slots.** Six separate inputs would break paste, break iOS one-time-code autofill, and fight the keyboard. `inputMode="numeric"` + `autoComplete="one-time-code"` + `pattern="[0-9]*"` is what makes the right keyboard appear.
- **The code is in the email subject line**, so it is readable from a notification preview without opening the message — the single biggest lever on completion rate for email-delivered codes.
- **A 60-second resend countdown** instead of a button that errors against the server's rate limit.
- **The pending sign-in survives leaving the app.** Requesting a code means going
  to the mail app, and on a phone that is enough for iOS to discard and relaunch
  the page. The address and step are persisted (10-minute TTL, matching the code),
  so returning lands on the code screen rather than a blank email field. An
  expired code falls back to the email step with the address still filled in.
- **"Paste code from clipboard"**, because the user has just copied it in Mail.
  Clipboard reads need permission on iOS, so the control only renders where the
  API exists, and a refusal falls back to typing.
- **Auto-submit is idempotent.** A `submitted` ref prevents the double-submit that a re-render or a stray Enter press would otherwise cause.
- **Errors are sentences, not codes.** "That code didn't work. Check it and try again, or send a new one."

**Touch and layout**

- **`100dvh`, not `100vh`** — Safari's collapsing toolbar otherwise leaves a dead band.
- **`env(safe-area-inset-*)` on every edge** plus `viewport-fit=cover`, so the header clears the notch and the FAB clears the home indicator.
- **16px minimum on every input.** Below that, iOS zooms the whole viewport on focus, and the layout never quite recovers.
- **`-webkit-tap-highlight-color: transparent` and `touch-action: manipulation`** — no grey flash, no 300ms double-tap-zoom delay.
- **Real pressed states** (`transform: scale(0.975)` on `:active`) — the absence of a press response is the most common "this feels like a website" tell.
- **44×44px minimum hit targets**, `:focus-visible` outlines, and every animation inside a `prefers-reduced-motion` guard.
- **System font stack** — zero font downloads, and text that matches the platform's own.

**Perceived performance**

- **Cache-first reads.** The persisted query cache renders the last known list immediately; the network reconciles behind it.
- **Optimistic writes.** A new note appears before the round trip completes, with a `is-pending` dim and a rollback on failure.
- **Skeletons on first load only**, never on a refresh — the shimmer sits where the content will land, so nothing jumps.
- **`networkMode: "offlineFirst"`** and an offline banner that says "showing saved items" rather than failing.

**App-ness**

- **Real manifest**: `display: standalone`, maskable icon inside the safe zone, `theme-color` per colour scheme, a `shortcuts` entry that opens straight into composing.
- **Hand-generated icons** (`scripts/gen-icons.mjs`) — a tiny PNG encoder, so the icon set is versioned code rather than binary blobs nobody can regenerate.
- **A service worker with a stated policy**: network-first navigations with an offline shell fallback, cache-first hashed assets, and **`/api/*` never cached** — caching API responses in the SW could serve one user's data to the next person who opens the app.
- **iOS-specific meta tags** (`apple-mobile-web-app-*`, `apple-touch-icon`) because iOS ignores the manifest for those.
- **An honest install prompt**: a real button on Android where `beforeinstallprompt` exists, and "Tap Share, then Add to Home Screen" on iOS where no API exists. Dismissal is remembered.

---

## 7a. Staying signed in

The user is not asked for a code once a month, or once a week — in practice not
for three months at a stretch. That is already how
it behaves — the code is only needed when there is no valid session cookie.

| Mechanism | Value | Effect |
| --- | --- | --- |
| Session lifetime | `expiresIn: 90 days` | The cookie is issued with `Max-Age=7776000`. |
| Rolling refresh | `updateAge: 7 days` | A returning user's expiry moves forward weekly, so an active user never re-authenticates. |
| Cookie flags | `HttpOnly; Secure; SameSite=Lax` | Not readable by JavaScript, TLS-only, not sent cross-site. |
| Storage | `navigator.storage.persist()` | Asks the browser not to evict the cached list. Sign-in does not depend on it. |

Verified on the live deployment: a cookie captured at 10:49 still authenticated at
12:23 with no code in between. The issued cookie carries `Max-Age=7776000` (90 days),
verified locally against a fresh sign-in.

### The iOS nuance that actually matters

WebKit's ITP deletes **script-written** storage after seven *Safari-use days*
without interaction, and caps client-side cookies (`document.cookie`) at seven
days. Two consequences for us:

- **The session cookie is safe.** It is set by the server with `HttpOnly`, so it
  is not script-writable and is not swept by that rule. Sign-in survives.
- **The cached note list is not.** It lives in `localStorage`, which ITP can clear.
  The cost is one refetch, not a sign-out — which is exactly why the cache is
  modelled as a cache and never as the source of truth.

WebKit also counts usage separately for **home-screen web apps**, which run
outside Safari with their own counter, and states that first-party data in an
installed web app is not expected to be deleted. So on iOS, *installing* is what
makes persistence dependable — one more reason the install prompt on the sign-in
flow is not cosmetic.

References: [ITP 2.3 (script-writable storage, HttpOnly guidance)](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/),
[the seven-day cap](https://openpwa.net/reference/storage/safari-seven-day-cap/).

## 8. Platform constraints that shaped this design

These are the findings that changed decisions, not decoration. Each one is why some obvious-looking choice above is not the choice made.

| Constraint | Consequence in this design |
| --- | --- |
| **Render blocks outbound SMTP**: port 25 for all services, and **465/587 as well on free instances**. ([docs](https://render.com/docs/free.md)) | No nodemailer. Email goes out over **Resend's HTTPS API**. An SMTP client would pass locally and fail in production — the worst kind of bug. |
| **Free web services spin down after 15 min idle, and take about a minute to come back.** ([docs](https://render.com/docs/free.md)) | For a *native* app this would be fatal: the first request of a session would stall ~50s. For this PWA it is survivable — the shell is a free static site that never sleeps — but a **paid instance is the recommendation** the moment anyone real uses it. The sign-in request is the first API call a new user makes, which is exactly the wrong one to make cold. |
| **Free Render Postgres expires 30 days after creation** (14-day grace, then deleted; no backups; one free database per workspace). ([docs](https://render.com/docs/free.md)) | Free tier is for prototypes only. `render.yaml` carries `plan: free` **with a comment saying so**, and the upgrade to `0.1c-256mb` ($6/mo) is a one-line change. |
| **`preDeployCommand` is paid-plan only.** ([blueprint spec](https://render.com/docs/blueprint-spec.md)) | Migrations could not assume a pre-deploy hook, so `RUN_MIGRATIONS_ON_BOOT=1` runs them at startup — idempotent, tolerant of concurrent instances, and correct on both tiers. The pre-deploy command is documented in `render.yaml` for when the plan is upgraded. |
| **Static-site rewrites may target a full external URL.** ([docs](https://render.com/docs/redirects-rewrites.md)) | Enables the same-origin API, which is what keeps session cookies first-party. Flagged as a first-deploy verification step (§4) precisely because it is load-bearing. |
| **iOS evicts script-writable storage after ~7 days of non-use** unless installed. | The local cache is an accelerator with a `buster` version, never the source of truth. All state lives in Postgres. |
| **iOS Web Push requires Add to Home Screen (16.4+).** | Push is not a design assumption. Re-engagement has to come from email. |
| **`one-time-code` autofill is SMS-oriented.** | The email code path must be fast *without* autofill: subject-line code, 10-minute expiry, one-tap paste, auto-submit. |
| **A free instance is 512 MB, 0.1 CPU, and gets OOM-killed.** | The start command counts against that budget: launching through `pnpm` cost ~160 MB and 3 s of boot. Production runs `node dist/server.js` directly, and the app logs its RSS every 5 minutes so an OOM is diagnosable rather than mysterious. |
| **Render's default Node is pinned to a moving major.** Unbounded `engines` ranges resolve to `latest`. ([docs](https://render.com/docs/node-version.md)) | `.node-version` pins 24.22.1 and `engines` is bounded `>=22 <27`, so a deploy cannot silently land on a new major. |
| **Render introduced new compute-plan IDs in Aug 2026** (`0.5c-512mb` replacing `starter`). | `render.yaml` uses the current IDs, with the legacy names noted. |

---

## 9. Cost

| Resource | Prototype | Real users |
| --- | --- | --- |
| Static site | **$0** (always, CDN + TLS included) | $0 |
| Web service | **$0** free — *spins down, 750 hrs/month* | **$7/mo** (`0.5c-512mb`) |
| Postgres | **$0** free — *expires in 30 days* | **$6/mo** (`0.1c-256mb`) |
| Workspace plan | Hobby **$0** | Hobby $0 / Pro $25 (compliance features) |
| Email | Resend free: **100/day**, 3 domains | Resend Pro from $20/mo |
| App stores | **$0** — no store, no developer accounts | $0 |
| **Total** | **$0** | **~$13/month** |

Compare honestly: a React Native or Flutter app would add $99/year for the Apple Developer Program, a Mac (or an EAS subscription, [$19–199/mo](https://expo.dev/pricing)) for iOS builds, and review latency on every release.

---

## 10. Runbook

### Local development — no accounts, no installs

```bash
pnpm install
pnpm --filter @portal/api db:migrate     # creates apps/api/.pglite (Postgres 18 in WASM)
pnpm dev                                  # API :8787, app :5173
```

Sign in by requesting a code and reading it from the API log:

```
  ┌─ dev OTP ────────────────────────────────
  │  to:   you@example.com
  │  code: 588847
```

### Deploy

1. Push to a Git repo, then in Render: **New → Blueprint**, pick the repo. `render.yaml` creates all three resources.
2. After the first deploy, set the two values Render cannot know in advance:
   - `BETTER_AUTH_URL` = the API's public URL (`https://portal-api.onrender.com`)
   - `TRUSTED_ORIGINS` = the static site's URL (`https://portal-pwa.onrender.com`)
3. **Check the rewrite target.** `render.yaml` assumes the API is named `portal-api`. If it is not, update the `/api/*` rewrite destination on the static site.
4. Set `RESEND_API_KEY` and `MAIL_FROM` (verify the domain in Resend first — DKIM/SPF/DMARC), or leave them unset and read codes from the API logs.
5. Smoke test, in order:
   ```bash
   curl https://<api>/api/health
   curl -X POST https://<site>/api/auth/email-otp/send-verification-otp \
        -H 'content-type: application/json' -d '{"email":"you@you.com","type":"sign-in"}'
   ```
   Then the real test: open the site on a phone, sign in, **Add to Home Screen**, and relaunch from the icon.

### Verification checklist before real users

- [ ] `/api/*` rewrite survives POST bodies and cookies (§4)
- [ ] Session survives an app relaunch and a browser restart
- [ ] Codes reject on the 4th attempt; resend is rate limited
- [ ] `BETTER_AUTH_SECRET` set, and boot fails in production without it
- [ ] Postgres moved off the 30-day free plan
- [ ] Web service moved off the free plan (cold starts)
- [ ] Lighthouse mobile: installable, and LCP under 2.5s on throttled 4G
- [ ] VoiceOver / TalkBack pass on the sign-in flow (the code input is a single labelled field)

---

## 11. When to leave this architecture

The PWA choice is reversible in one direction and expensive in the other. Pull the trigger on native if, and only if:

- **Push becomes load-bearing** for the product (not just nice-to-have).
- **Camera, Bluetooth, NFC, or background location** become core. (Camera *capture* still works in a browser; continuous access does not.)
- **Offline is a day-one requirement**, not a fallback, and iOS's storage eviction makes that impossible to guarantee.
- **Store distribution is the acquisition channel.**

The migration is unusually cheap here, and that is by design: Expo brings the same TypeScript, the same React components, and the same Hono API. `apps/pwa` would be moved onto Expo Router, calling the identical `/api/*` behind the identical auth. **Nothing on the server changes.** The decisions to keep from day one: types shared across the wire, auth owned in our own Postgres, and no browser-only assumptions in the data layer.

The other axis — leaving Render — is cheap too. It is a Node process, a Postgres connection string, and a static directory.

---

## 12. What is verified, and what is not

### Verified on a live Render deployment

Deployed 2026-11-18: static site `portal-pwa.onrender.com`, API
`portal-api-7i3v.onrender.com`, Postgres `portal-db` (free plan, expires
**2026-12-18**). Each item below was executed against the real URLs:

- **`/api/*` rewrite proxies correctly** — `POST` with a JSON body through the
  static site's origin returned `200 {"success":true}`; methods and bodies
  survive the proxy.
- **Session cookie is first-party** — set on `portal-pwa.onrender.com` as
  `__Secure-better-auth.session_token; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`.
  No CORS, no `SameSite=None`, no third-party-cookie exposure.
- **Email-code sign-in works end to end** — code read from the service logs,
  exchanged for a session, `/api/me` returned the user.
- **The auth gate holds** — `/api/notes` returns `401` without the cookie.
- **Data is in Render Postgres, not local** — the note and the session survived
  a **redeploy**, which wipes Render's ephemeral filesystem. This is the decisive
  test that `DATABASE_URL` was wired and boot migrations ran (`database schema up
  to date` in the logs).
- **Cross-user isolation in production** — a second account saw an empty list,
  and `PATCH`/`DELETE` against the first user's note id both returned `404`.
- **Static-site behaviour** — SPA fallback serves the shell for deep paths;
  `/sw.js` is `no-cache`; `/assets/*` is `immutable`; the manifest is served as
  `application/manifest+json` (it needed a header rule to be installable).
- **Cold start, measured** — after 17 minutes idle, the first request took
  **26.5 s** (TCP connect 0.12 s, so the time is the instance waking, not the
  network). The next requests took 0.26–0.31 s. This is the concrete number
  behind "move the API to a paid instance": a first-time user signing in would
  wait half a minute for the screen that mails them a code.
- **9/9 integration tests** still pass locally against real Postgres (PGlite),
  and typecheck is clean across both packages.

### Four things only a real deploy could reveal

1. **Service hostnames get a suffix.** `portal-api` was taken, so Render
   assigned `portal-api-7i3v.onrender.com`. A hardcoded rewrite destination —
   which is exactly what the blueprint had — would have 502'd every API call.
   The destination must be copied from the API's real URL after creation.
2. **`envVars` in `POST /v1/services` were silently ignored.** `BETTER_AUTH_SECRET`
   (`generateValue: true`), `NODE_ENV` and `RUN_MIGRATIONS_ON_BOOT` never landed,
   so the service booted without a signing key, threw on the first auth request,
   and died (502). Setting variables per key via
   `PUT /v1/services/{id}/env-vars/{key}` works. **Always list the env vars back
   and confirm they exist.**
3. **Env-var changes do not trigger a deploy.** They need an explicit
   `POST /v1/services/{id}/deploys`, otherwise the old build keeps running with
   the old environment.
4. **The manifest was served as `binary/octet-stream`**, which stops Chrome from
   offering installation. The body was valid JSON, so nothing local could catch
   it. Fixed with a `Content-Type: application/manifest+json` header rule; the
   fix is now in `render.yaml`.

### The OOM kill, and what actually caused it

A free instance has **512 MB** and is restarted if it exceeds it. `portal-api` was
killed this way at **335 MB**. The cause was not the application — it was the
process wrapper around it, in two layers. Measured on the live service, Render's
own memory metric:

| Start command | RSS | Note |
| --- | --- | --- |
| `pnpm --filter @portal/api start` (→ `tsx`) | **335 MB** | esbuild resident for TypeScript |
| `pnpm --filter @portal/api start` (→ `node dist`) | **248 MB** | still a `pnpm` parent process |
| `node apps/api/dist/server.js` | **71–88 MB** | one process, nothing else |

Removing `tsx` helped (−87 MB). Removing the **`pnpm` wrapper** was the bigger
win (−160 MB): `pnpm run` keeps itself resident as the parent of the app, which
on a 0.1-CPU/512 MB instance is a quarter of the budget spent on a launcher.
Locally the same comparison measured 319 MB for the pnpm tree against 193 MB for
`node` alone, with boot time 8.9 s versus 5.6 s.

Two lessons worth keeping:

- **On small instances, the start command is part of the memory budget.** Prefer
  invoking the runtime directly (`node dist/server.js`) over a package-manager
  shim.
- **Instrument before guessing.** `process.memoryUsage()` disagreed with the
  container metric (91 MB versus 248 MB), and that gap was the tell: the app was
  fine and something *around* it was not. A five-minute RSS heartbeat makes that
  visible; without it, an OOM kill leaves no evidence at all.

The service now also sets `NODE_OPTIONS=--max-old-space-size=320`, so V8 collects
before the container limit kills the process.

### Email delivery, wired and verified

`RESEND_API_KEY` and `MAIL_FROM` are set on the service, and `GET /api/config`
reports `{"mailDelivery":"resend"}`. A sign-in code was sent in **561 ms** — a
real HTTPS round trip — with no console fallback, and arrived in the inbox. The
code is in the **subject line** (`Your sign-in code: 123456`) so it is readable
from a notification without opening the message.

The client reads that same `/api/config` flag, so a deployment without email
credentials now says *"the code is in the server log"* instead of falsely
claiming an email was sent. That defect only surfaced by using the app.

> The key in use is **sending-only** (it cannot list domains) and the sender is
> Resend's shared test address, which delivers **only to the account owner**.
> Both are correct for verification and wrong for production.

### Still not verified

- **Visual rendering and interaction.** No browser exists on this device, so the
  CSS, safe-area behaviour and the code-input feel have never been seen. This
  remains the highest-risk gap.
- **Delivery to arbitrary addresses.** Real email is wired and verified (see
  below), but through Resend's shared test sender `onboarding@resend.dev`, which
  only delivers to the address that owns the Resend account. Sending to real
  users requires verifying a domain (SPF/DKIM/DMARC).
- **iOS specifics**: home-screen install, standalone chrome, storage eviction,
  and how the code-bearing subject line renders in the Mail app.
