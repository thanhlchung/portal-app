import type { LeaderboardEntry, YourBest } from "@portal/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, ApiError, isOfflineError, unwrap } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { linkProps, navigate } from "../lib/router";

interface BoardPayload {
  scores: LeaderboardEntry[];
  you: YourBest | null;
}

function formatScore(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(4, "0");
}

/** "12 Mar" — the year is noise on a board that only holds recent runs. */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

export default function ScoresScreen() {
  const queryClient = useQueryClient();
  const boardQuery = useQuery({
    queryKey: ["scores"],
    queryFn: async () => unwrap<BoardPayload>(await api.scores.$get()),
  });

  // A 401 here means the session is gone, not that the board is broken.
  useEffect(() => {
    const error = boardQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut().then(() => queryClient.clear());
    }
  }, [boardQuery.error, queryClient]);

  const scores = boardQuery.data?.scores ?? [];
  const you = boardQuery.data?.you ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand brand--link" {...linkProps("/")}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </a>
        <div className="header-actions">
          <button
            className="link-button link-button--muted"
            type="button"
            onClick={() => void boardQuery.refetch()}
            disabled={boardQuery.isFetching}
          >
            {boardQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <a className="button button--compact button--primary" {...linkProps("/play")}>
            Play
          </a>
        </div>
      </header>

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">High scores</h1>
          <span className="screen-meta">Asteroids</span>
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
                ? "You appear to be offline. Scores are stored on the server, so they need a connection."
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
        ) : (
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
                    Play a round and save the score to take your place on the board.
                  </p>
                </div>
              </section>
            )}

            {scores.length === 0 ? (
              <div className="empty">
                <p className="empty-title">The board is empty</p>
                <p className="empty-sub">Be the first name on it.</p>
                <button
                  className="button button--compact button--primary"
                  type="button"
                  onClick={() => navigate("/play")}
                >
                  Play now
                </button>
              </div>
            ) : (
              <ol className="score-list">
                {scores.map((entry, index) => (
                  <li
                    key={entry.id}
                    className={`score-row ${entry.isYou ? "is-you" : ""}`}
                  >
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
        )}
      </main>
    </div>
  );
}
