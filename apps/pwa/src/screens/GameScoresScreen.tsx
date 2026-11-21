import type { LeaderboardEntry, VersusRecord, YourBest } from "@portal/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { GameMeta } from "../games/registry";
import { formatDay, formatScore } from "../games/shared/format";
import { api, ApiError, isOfflineError, unwrap } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { linkProps } from "../lib/router";

/**
 * The board page for one game.
 *
 * It renders two different boards because there are two different questions:
 * a score game ranks runs high-to-low, a versus game ranks players by wins.
 * Fetching the wrong endpoint is a 400 on purpose — the server refuses to
 * pretend a match is a score.
 */

interface ScoreBoard {
  kind: "score";
  scores: LeaderboardEntry[];
  you: YourBest | null;
}

interface VersusBoard {
  kind: "versus";
  records: VersusRecord[];
  you: VersusRecord | null;
}

type BoardPayload = ScoreBoard | VersusBoard;

export default function GameScoresScreen({ game }: { game: GameMeta }) {
  const queryClient = useQueryClient();
  const boardQuery = useQuery({
    queryKey: ["scores", game.slug],
    queryFn: async (): Promise<BoardPayload> =>
      game.kind === "versus"
        ? unwrap<VersusBoard>(
            await api.games[":slug"].matches.$get({ param: { slug: game.slug } }),
          )
        : unwrap<ScoreBoard>(await api.games[":slug"].scores.$get({ param: { slug: game.slug } })),
  });

  // A 401 here means the session is gone, not that the board is broken.
  useEffect(() => {
    const error = boardQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut().then(() => queryClient.clear());
    }
  }, [boardQuery.error, queryClient]);

  const board = boardQuery.data;
  const scores = board?.kind === "score" ? board.scores : [];
  const records = board?.kind === "versus" ? board.records : [];
  const versus = game.kind === "versus";

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand brand--link" {...linkProps("/")}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </a>
        <div className="header-actions">
          <a className="link-button link-button--muted" {...linkProps("/play")}>
            Games
          </a>
          <a className="link-button link-button--muted" {...linkProps("/share")}>
            Share
          </a>
          <button
            className="link-button link-button--muted"
            type="button"
            onClick={() => void boardQuery.refetch()}
            disabled={boardQuery.isFetching}
          >
            {boardQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <a
            className="button button--compact button--primary"
            {...linkProps(`/play/${game.slug}`)}
          >
            Play
          </a>
        </div>
      </header>

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">{versus ? "Match records" : "High scores"}</h1>
          <span className="screen-meta">{game.title}</span>
        </div>

        {boardQuery.isPending ? (
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
          </div>
        ) : boardQuery.isError ? (
          <div className="empty">
            <p className="empty-title">Couldn&apos;t load the board</p>
            <p className="empty-sub">
              {isOfflineError(boardQuery.error)
                ? "You appear to be offline. Results are stored on the server, so they need a connection."
                : "Something went wrong on the way to the server."}
            </p>
            <button
              className="button button--compact"
              type="button"
              onClick={() => void boardQuery.refetch()}
            >
              Try again
            </button>
          </div>
        ) : versus ? (
          <RecordsBoard
            game={game}
            records={records}
            you={board?.kind === "versus" ? board.you : null}
          />
        ) : (
          <ScoresBoard game={game} scores={scores} you={board?.kind === "score" ? board.you : null} />
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------- score board */

function ScoresBoard({
  game,
  scores,
  you,
}: {
  game: GameMeta;
  scores: LeaderboardEntry[];
  you: YourBest | null;
}) {
  return (
    <>
      {you ? (
        <section className="best-card" aria-label="Your best run">
          <div className="best-main">
            <p className="best-label">Your best</p>
            <p className="best-score">{formatScore(you.score)}</p>
          </div>
          <div className="best-meta">
            <p>
              <span className="best-meta-label">Rank</span>
              <span className="best-meta-value">#{you.rank}</span>
            </p>
            <p>
              <span className="best-meta-label">Level</span>
              <span className="best-meta-value">{you.level}</span>
            </p>
            <p>
              <span className="best-meta-label">Set</span>
              <span className="best-meta-value">{formatDay(you.createdAt)}</span>
            </p>
          </div>
        </section>
      ) : (
        <section className="best-card best-card--empty" aria-label="Your best run">
          <div className="best-main">
            <p className="best-label">No run recorded yet</p>
            <p className="empty-sub">
              Play a round of {game.title} and save the score to take your place on the board.
            </p>
          </div>
        </section>
      )}

      {scores.length === 0 ? (
        <div className="empty">
          <p className="empty-title">The board is empty</p>
          <p className="empty-sub">Be the first name on it.</p>
          <a className="button button--compact button--primary" {...linkProps(`/play/${game.slug}`)}>
            Play now
          </a>
        </div>
      ) : (
        <ol className="score-list">
          {scores.map((entry, index) => (
            <li key={entry.id} className={`score-row ${entry.isYou ? "is-you" : ""}`}>
              <span className="score-rank">{index + 1}</span>
              <span className="score-name">
                {entry.playerName}
                {entry.isYou ? <span className="score-you">you</span> : null}
              </span>
              <span className="score-level">L{entry.level}</span>
              <span className="score-points">{formatScore(entry.score)}</span>
            </li>
          ))}
        </ol>
      )}

      {you && you.rank > scores.length ? (
        <p className="board-note">
          Your best run is at rank #{you.rank}, outside the top {scores.length} shown here.
        </p>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------- records board */

function RecordsBoard({
  game,
  records,
  you,
}: {
  game: GameMeta;
  records: VersusRecord[];
  you: VersusRecord | null;
}) {
  return (
    <>
      {you ? (
        <section className="best-card" aria-label="Your record">
          <div className="best-main">
            <p className="best-label">Your record</p>
            <p className="best-score">
              {you.wins}–{you.losses}–{you.draws}
            </p>
          </div>
          <div className="best-meta">
            <p>
              <span className="best-meta-label">Rank</span>
              <span className="best-meta-value">#{you.rank}</span>
            </p>
            <p>
              <span className="best-meta-label">Played</span>
              <span className="best-meta-value">{you.played}</span>
            </p>
            <p>
              <span className="best-meta-label">Wins</span>
              <span className="best-meta-value">{you.wins}</span>
            </p>
          </div>
        </section>
      ) : (
        <section className="best-card best-card--empty" aria-label="Your record">
          <div className="best-main">
            <p className="best-label">No matches recorded yet</p>
            <p className="empty-sub">
              Win or lose, save the result to start your {game.title} record.
            </p>
          </div>
        </section>
      )}

      {records.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nobody has played yet</p>
          <p className="empty-sub">Be the first on the board.</p>
          <a className="button button--compact button--primary" {...linkProps(`/play/${game.slug}`)}>
            Play now
          </a>
        </div>
      ) : (
        <ol className="score-list">
          {records.map((record) => (
            <li
              key={`${record.playerName}-${record.rank}`}
              className={`score-row score-row--records ${record.isYou ? "is-you" : ""}`}
            >
              <span className="score-rank">{record.rank}</span>
              <span className="score-name">
                {record.playerName}
                {record.isYou ? <span className="score-you">you</span> : null}
              </span>
              <span className="score-wld" title="Wins">
                <strong>{record.wins}</strong>W
              </span>
              <span className="score-wld" title="Losses">
                {record.losses}L
              </span>
              <span className="score-wld" title="Draws">
                {record.draws}D
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="board-note">
        Ranked by wins, then draws, then fewest losses. A match result is not a score.
      </p>
    </>
  );
}
