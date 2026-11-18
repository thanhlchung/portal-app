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

Email sending is not wired, so **sign-in codes appear in the API logs** rather than in an
inbox. See `docs/ARCHITECTURE.md` §12 for what was verified on this deployment and the four
things only a live deploy revealed — including why the `/api/*` rewrite destination must be
copied from the API's real hostname.

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

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API (watch mode) + PWA dev server together |
| `pnpm dev:api` / `pnpm dev:pwa` | Run one side only |
| `pnpm test` | Integration tests: real Postgres, real auth, real routes |
| `pnpm typecheck` | Typecheck every package |
| `pnpm build` | Production build of the PWA |
| `pnpm db:migrate` | Apply migrations |
| `pnpm --filter @portal/api db:generate` | Generate SQL migrations after a schema edit |

## Layout

```
apps/api      Hono service — auth, notes API, schema, migrations, tests
apps/pwa      React app — sign-in, notes, service worker, manifest, icons
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
