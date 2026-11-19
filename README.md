# Portal

A phone-first **PWA** backed by a **Render** deployment: React + Vite client, Hono API,
Render Postgres, and passwordless sign-in with a six-digit code emailed to the user.

The reasoning behind every choice — including what this architecture cannot do — is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Live deployment

| | |
| --- | --- |
| App (open on a phone) | <https://portal-pwa.onrender.com> |
| API | <https://portal-api-7i3v.onrender.com/api/health> |
| Plan | free — API sleeps after 15 min idle (~1 min to wake) |
| Database | free Render Postgres, **expires 2026-12-18** |

Sign-in codes are emailed via Resend, from the shared test sender
`onboarding@resend.dev` — which only delivers to the Resend account owner. For real users,
verify a domain in Resend and change `MAIL_FROM`. If the credentials are ever absent, the app
says so plainly and writes codes to the server log instead of pretending to send. See
`docs/ARCHITECTURE.md` §12 for everything verified on this deployment, including why the
`/api/*` rewrite destination must be copied from the API's real hostname.

---

## Run it locally

No database to install, no cloud account, no email provider. The API embeds Postgres 18
(PGlite) on disk, and prints sign-in codes to its own log.

```bash
pnpm install
pnpm db:migrate      # creates apps/api/.pglite from the committed SQL migrations
pnpm dev             # API on :8787, app on :5173
```

Open <http://localhost:5173>, enter any email address, then read the code from the API log:

```
  ┌─ dev OTP ────────────────────────────────
  │  to:   you@example.com
  │  code: 588847
  └──────────────────────────────────────────
```

To use a real Postgres instead, set `DATABASE_URL` in `apps/api/.env` (see `.env.example`).
To send real email, set `RESEND_API_KEY` and `MAIL_FROM` — over HTTPS, never SMTP
(Render blocks outbound SMTP, including 587 on free instances).

## Screens

The client routes on the path — no router dependency, one namespace for games so the URL can
grow:

| Path | Screen |
| --- | --- |
| `/` | Notes (the portal's original screen) |
| `/play` | Games hub — one card per game, with your best and the top score |
| `/play/<slug>` | That game, e.g. `/play/asteroids` |
| `/play/<slug>/scores` | That game's board — top 20 plus your own best and rank |
| `/scores` | Legacy alias → the default game's board (bookmarks, cached shells) |

Each game is its own lazy chunk (`React.lazy` via the registry), so opening one never downloads
another's engine: the initial shell is ~101 KB gzipped and the Asteroids chunk is ~8 KB on top.
A game's slug is its identity everywhere — the URL, the API path, and the `game` column that
scopes its board.

**Adding a game** is one registry entry, one definition, and an engine:

```
apps/pwa/src/games/registry.ts        the one list: slug, title, blurb, lazy component
apps/pwa/src/games/slugs.ts           the slugs alone (dependency-free, imported by the API tests)
apps/pwa/src/games/shared/            ArcadeShell, formatting, the test harness
apps/pwa/src/games/<slug>/            engine + definition.tsx + a three-line Game.tsx
```

Everything a game should not re-implement lives in `games/shared/ArcadeShell.tsx`: the canvas
and the engine's lifecycle, the HUD frame, the touch controls, the start/paused/game-over
overlays, the score-saving panel (rank, nickname, retry, session expiry), mute, toasts, and the
links to `/play` and the board. A game supplies a **definition** — its controls, a HUD renderer,
an intro renderer, an engine factory, and a mapping from its result to `{ score, level }` — and
`Game.tsx` is three lines. `games/asteroids/Game.tsx` is literally the whole of that game's
integration.

The engines themselves stay React-free and take the shell's callbacks as opaque events, so a
60 fps loop never re-renders the component tree.

Asteroids is a port of a standalone 900-line `asteroids.html` into typed modules. `engine.ts`
owns the canvas and the frame loop, `audio.ts` the Web Audio effects, `constants.ts` the
tuning. The engine knows nothing about React — it reports score, phase and game-over events
through callbacks, and the React shell (`games/asteroids/Game.tsx`) draws the HUD, menus and the
game-over panel. That split is what keeps 60 fps out of the component tree.

A finished run is saved with a nickname, and each board is server-side and per game:

```
GET  /api/games                  → { games: [{ slug, top, you }] }   the hub, one card per game
GET  /api/games/<slug>/scores    → { game, scores: [{ id, playerName, score, level, createdAt, isYou }], you: { score, level, createdAt, rank } | null }
POST /api/games/<slug>/scores    → { game, score: { …entry }, rank }   body: { score, level, playerName? }
GET  /api/scores · POST /api/scores   alias for the default game (asteroids)
```

All require a session. An unknown slug is a `404`, not a new empty board — the server validates
against its own allowlist (`apps/api/src/games.ts`), and a test proves every game the client can
play has a board there. Boards are capped at 20 rows; ties are ordered by time, so an equal score
never demotes an earlier run. Scores are client-reported — validation bounds them (≤ 1 000 000
points, level ≤ 100, 24-character name) but a determined player can still claim any number; see
`docs/ARCHITECTURE.md` §6 for why that is accepted and what it would take to fix.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API (watch mode) + PWA dev server together |
| `pnpm dev:api` / `pnpm dev:pwa` | Run one side only |
| `pnpm test` | Integration tests (real Postgres, real auth, real routes) + headless game-engine tests |
| `pnpm typecheck` | Typecheck every package |
| `pnpm build` | Production build of the PWA |
| `pnpm db:migrate` | Apply migrations |
| `pnpm --filter @portal/api db:generate` | Generate SQL migrations after a schema edit |

## Layout

```
apps/api      Hono service — auth, notes + per-game scores API, schema, migrations, tests
apps/pwa      React app — sign-in, notes, games hub, service worker, manifest
apps/pwa/src/games         registry, shared slugs, one folder per game (no React in engines)
docs          ARCHITECTURE.md
render.yaml   API + Postgres + static site, as code
```

## Deploying

`render.yaml` defines all three Render resources. Push to a repo, then **New → Blueprint** in
Render. Two values must be set in the Dashboard after the first deploy
(`BETTER_AUTH_URL`, `TRUSTED_ORIGINS`), and the static site's `/api/*` rewrite must point at
the API's actual hostname. The full runbook — including the two things worth verifying before
real users touch it — is in [§10 of the architecture doc](docs/ARCHITECTURE.md#10-runbook).

Costs: **$0** to prototype, **~$13/month** for a deployment with a paid API instance
($7) and a non-expiring Postgres ($6). The free tiers spin down and expire — that is stated
plainly in `render.yaml` next to the settings.
