import type { GameSummary } from "@portal/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { games } from "../games/registry";
import { formatScore } from "../games/shared/format";
import { api, unwrap } from "../lib/api";
import { linkProps, navigate } from "../lib/router";

/**
 * The games hub at `/play`.
 *
 * It exists so the URL scheme can grow: with one game `/play` is a single card,
 * and it needs no restructuring for the second. Best scores come from one
 * request (`GET /api/games`) rather than one board request per card.
 */

export default function GamesLauncher() {
  const hubQuery = useQuery({
    queryKey: ["games"],
    queryFn: async () => unwrap<{ games: GameSummary[] }>(await api.games.$get()),
  });

  const summaries = new Map(
    (hubQuery.data?.games ?? []).map((summary) => [summary.slug, summary] as const),
  );

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand brand--link" {...linkProps("/")}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </a>
        <div className="header-actions">
          <a className="link-button link-button--muted" {...linkProps("/")}>
            Notes
          </a>
        </div>
      </header>

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">Games</h1>
          <span className="screen-meta">
            {games.length} {games.length === 1 ? "game" : "games"}
          </span>
        </div>

        {hubQuery.isError ? (
          <p className="status-bar" role="status">
            Scores are unavailable right now — you can still play.
          </p>
        ) : null}

        <ul className="game-grid">
          {games.map((game) => {
            const summary = summaries.get(game.slug);
            return (
              <li key={game.slug} className="game-card">
                <div className="game-card-head">
                  <h2 className="game-card-title">{game.title}</h2>
                  <p className="game-card-blurb">{game.blurb}</p>
                  <p className="game-card-controls">{game.controls}</p>
                </div>

                <dl className="game-card-stats">
                  {hubQuery.isPending ? (
                    <>
                      <div>
                        <dt>Your standing</dt>
                        <dd>…</dd>
                      </div>
                    </>
                  ) : summary?.kind === "versus" ? (
                    <>
                      <div>
                        <dt>Your record</dt>
                        <dd>
                          {summary.you
                            ? `${summary.you.wins}W · ${summary.you.losses}L · ${summary.you.draws}D`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Most wins</dt>
                        <dd>
                          {summary.top
                            ? `${summary.top.wins} · ${summary.top.playerName}`
                            : "—"}
                        </dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>Your best</dt>
                        <dd>
                          {summary?.kind === "score" && summary.you
                            ? `${formatScore(summary.you.score)} · #${summary.you.rank}`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Top score</dt>
                        <dd>
                          {summary?.kind === "score" && summary.top
                            ? `${formatScore(summary.top.score)} · ${summary.top.playerName}`
                            : "—"}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>

                <div className="game-card-actions">
                  <a className="button button--primary" {...linkProps(`/play/${game.slug}`)}>
                    Play
                  </a>
                  <a className="link-button" {...linkProps(`/play/${game.slug}/scores`)}>
                    High scores
                  </a>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="board-note">
          One board per game — and a match result is not a score.
        </p>
      </main>
    </div>
  );
}

/**
 * `/scores` was the multi-game route's predecessor. Bookmarks, manifest
 * entries and older cached shells still point at it, so it forwards to the
 * default game's board instead of 404ing.
 */
export function RedirectTo({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);

  return (
    <div className="app">
      <main className="screen">
        <div className="skeleton-stack" aria-hidden="true">
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-row" />
        </div>
      </main>
    </div>
  );
}
