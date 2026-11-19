import type { LeaderboardEntry } from "@portal/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, unwrap } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { linkProps } from "../../lib/router";
import type { GameMeta, SessionUser } from "../registry";
import { formatScore } from "./format";
import type { ArcadeDefinition, ControlHandlers, GamePhase } from "./types";

/**
 * The arcade shell: everything a game should not have to think about.
 *
 * It owns the canvas and the engine's lifecycle, the HUD frame, the touch
 * controls, the start/paused/game-over overlays, the score-saving panel (query,
 * mutation, rank, nickname, 401 handling) and the links between `/play` and
 * `/play/<slug>/scores`. A game supplies a definition and nothing else.
 *
 * The frame loop stays *outside* React: the engine reports events, which set
 * state, which re-renders the shell — but the per-frame work never touches the
 * component tree.
 */

const NICKNAME_KEY = "portal.nickname";

interface SaveResponse {
  score: LeaderboardEntry;
  rank: number;
}

interface SavedState {
  rank: number;
  playerName: string;
}

interface BoardPayload {
  scores: LeaderboardEntry[];
  you: { score: number; rank: number } | null;
}

function defaultNickname(user: SessionUser): string {
  // Only ever a nickname: the leaderboard must not show an email address, and
  // the server strips anything after the "@" anyway.
  try {
    const stored = window.localStorage.getItem(NICKNAME_KEY);
    if (stored?.trim()) return stored.trim();
  } catch {
    // Private mode: fall through to the account name.
  }
  const name = user.name.trim();
  if (name) return name;
  return user.email.split("@")[0] ?? "Player";
}

export function ArcadeShell<Hud, Result>({
  game,
  user,
  definition,
}: {
  game: GameMeta;
  user: SessionUser;
  definition: ArcadeDefinition<Hud, Result>;
}) {
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<ReturnType<ArcadeDefinition<Hud, Result>["createEngine"]> | null>(null);

  const [phase, setPhase] = useState<GamePhase>("idle");
  const [hud, setHud] = useState<Hud | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [nickname, setNickname] = useState(() => defaultNickname(user));
  const [saved, setSaved] = useState<SavedState | null>(null);
  const toastTimer = useRef<number | null>(null);

  /** This player's best run in this game — shown before and after a run. */
  const boardQuery = useQuery({
    queryKey: ["scores", game.slug],
    queryFn: async () =>
      unwrap<BoardPayload>(
        await api.games[":slug"].scores.$get({ param: { slug: game.slug } }),
      ),
  });
  const personalBest = boardQuery.data?.you?.score ?? null;

  const saveScore = useMutation({
    mutationFn: async (input: { score: number; level: number; playerName: string }) =>
      unwrap<SaveResponse>(
        await api.games[":slug"].scores.$post({ param: { slug: game.slug }, json: input }),
      ),
    onSuccess: (data) => {
      setSaved({ rank: data.rank, playerName: data.score.playerName });
      try {
        window.localStorage.setItem(NICKNAME_KEY, data.score.playerName);
      } catch {
        // Non-fatal: the nickname just will not be remembered.
      }
      // Both the board and the hub summary (which shows each game's best) are
      // stale now.
      void queryClient.invalidateQueries({ queryKey: ["scores"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });

  // An expired session must not leave a finished run unsaveable with a generic
  // "couldn't save" message: sign out, which drops the player on sign-in.
  useEffect(() => {
    const error = saveScore.error ?? boardQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut().then(() => queryClient.clear());
    }
  }, [saveScore.error, boardQuery.error, queryClient]);

  // One engine per mount, rebuilt only if the game or its definition changes
  // (both are module constants, so in practice never). Rebuilding it would
  // restart the game under the player.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const engine = definition.createEngine(canvas, {
      onHud: setHud,
      onPhaseChange: setPhase,
      onMutedChange: setMuted,
      onGameOver: (finished) => {
        setResult(finished);
        setSaved(null);
        saveScore.reset();
      },
      onToast: (message) => {
        setToast(message);
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 1200);
      },
    });
    gameRef.current = engine;

    return () => {
      engine.destroy();
      gameRef.current = null;
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
    // `saveScore` is a stable mutation object; the engine must not be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, game.slug]);

  const startRun = useCallback(() => {
    setResult(null);
    setSaved(null);
    saveScore.reset();
    gameRef.current?.start();
  }, [saveScore]);

  /** Pointer-down/up on a touch control, with capture so release is reliable. */
  const hold = (name: string): ControlHandlers => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an optimisation, not a requirement.
      }
      gameRef.current?.setInput(name, true);
    },
    onPointerUp: () => gameRef.current?.setInput(name, false),
    onPointerCancel: () => gameRef.current?.setInput(name, false),
    onLostPointerCapture: () => gameRef.current?.setInput(name, false),
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  });

  const playing = phase === "playing";
  const submission = result === null ? null : definition.submission(result);
  // Only claim "personal best" once the board has actually loaded — otherwise a
  // first-time player is told every run is a record.
  const isNewBest =
    submission !== null &&
    boardQuery.isSuccess &&
    (personalBest === null || submission.score > personalBest);

  return (
    <div className="play">
      <canvas
        ref={canvasRef}
        className="play-canvas"
        aria-label={`${game.title} playfield`}
        onPointerDown={() => gameRef.current?.primaryAction()}
      />

      {phase !== "idle" && hud !== null ? (
        <div className="play-hud" aria-live="off">
          {definition.renderHud(hud)}
        </div>
      ) : null}

      <div className="play-corner play-corner--left">
        <a className="corner-button" aria-label="Back to games" title="Back" {...linkProps("/play")}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>

      <div className="play-corner play-corner--right">
        <button
          className="corner-button"
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
          // The engine owns mute and reports the new value through
          // `onMutedChange`, so this must not also flip local state — doing
          // both would cancel itself out.
          onClick={() => gameRef.current?.toggleMute()}
        >
          {muted ? "\u266A\u0338" : "\u266A"}
        </button>
        <button
          className="corner-button"
          type="button"
          aria-label={playing ? "Pause" : "Resume"}
          disabled={phase !== "playing" && phase !== "paused"}
          onClick={() => gameRef.current?.togglePause()}
        >
          {playing ? "\u2016" : "\u25B6"}
        </button>
      </div>

      {toast ? (
        <div className="play-toast" role="status">
          {toast}
        </div>
      ) : null}

      {playing && definition.controls.length > 0 && definition.renderControls ? (
        <div className="play-controls play-controls--custom">
          {definition.renderControls(hold)}
        </div>
      ) : null}

      {playing && definition.controls.length > 0 && !definition.renderControls ? (
        <div className="play-controls">
          <div className="control-group">
            {definition.controls
              .filter((control) => !control.big)
              .map((control) => (
                <button
                  key={control.name}
                  className="control-button"
                  type="button"
                  aria-label={control.label}
                  {...hold(control.name)}
                >
                  <span className="control-glyph" aria-hidden="true">
                    {control.glyph}
                  </span>
                  <span className="control-label">{control.label}</span>
                </button>
              ))}
          </div>
          {definition.controls
            .filter((control) => control.big)
            .map((control) => (
              <button
                key={control.name}
                className="control-button control-button--big"
                type="button"
                aria-label={control.label}
                {...hold(control.name)}
              >
                <span className="control-glyph" aria-hidden="true">
                  {control.glyph}
                </span>
                <span className="control-label">{control.label}</span>
              </button>
            ))}
        </div>
      ) : null}

      {phase === "idle" ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h1 className="play-title">{game.title.toUpperCase()}</h1>
            <p className="play-sub">{game.blurb}</p>
            {definition.renderIntro?.({ personalBest })}
            {definition.controls.length > 0 ? (
              <p className="play-sub play-sub--muted">
                On a phone, use the buttons along the bottom.
              </p>
            ) : null}
            {personalBest !== null ? (
              <p className="play-best">Your best: {formatScore(personalBest)}</p>
            ) : null}
            <button className="button button--primary play-start" type="button" onClick={startRun}>
              Launch
            </button>
            <a className="link-button" {...linkProps(`/play/${game.slug}/scores`)}>
              High scores
            </a>
          </div>
        </div>
      ) : null}

      {phase === "paused" ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h2 className="play-title play-title--small">PAUSED</h2>
            {hud !== null ? (
              <div className="play-hud play-hud--static">{definition.renderHud(hud)}</div>
            ) : null}
            <div className="play-actions">
              <button
                className="button button--primary"
                type="button"
                onClick={() => gameRef.current?.resume()}
              >
                Resume
              </button>
              <button className="button button--ghost" type="button" onClick={startRun}>
                Restart
              </button>
            </div>
            <a className="link-button" {...linkProps("/play")}>
              Quit to games
            </a>
          </div>
        </div>
      ) : null}

      {phase === "over" && submission ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h2 className="play-title play-title--small play-title--over">GAME OVER</h2>
            <p className="play-final">
              <span className="play-final-score">{formatScore(submission.score)}</span>
              <span className="play-final-meta">LEVEL {submission.level}</span>
            </p>
            {isNewBest ? <p className="play-best play-best--new">New personal best</p> : null}

            {saved ? (
              <p className="play-saved" role="status">
                Saved as <strong>{saved.playerName}</strong> &mdash; rank{" "}
                <strong>#{saved.rank}</strong>
              </p>
            ) : (
              <div className="play-save">
                <label className="field">
                  <span className="field-label">Name on the board</span>
                  <input
                    className="text-input"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    maxLength={24}
                    autoComplete="off"
                    enterKeyHint="done"
                  />
                </label>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={!nickname.trim() || saveScore.isPending}
                  onClick={() =>
                    saveScore.mutate({
                      score: submission.score,
                      level: submission.level,
                      playerName: nickname.trim(),
                    })
                  }
                >
                  {saveScore.isPending ? "Saving…" : "Save score"}
                </button>
                {saveScore.isError ? (
                  <p className="form-error" role="alert">
                    Couldn&apos;t save that run. Check your connection and try again.
                  </p>
                ) : null}
              </div>
            )}

            <div className="play-actions">
              {/* Saving is the primary action here: a run that is never saved
                  never reaches the board. Replaying stays one tap away. */}
              <button className="button button--ghost" type="button" onClick={startRun}>
                Play again
              </button>
              <a className="link-button" {...linkProps(`/play/${game.slug}/scores`)}>
                Leaderboard
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
