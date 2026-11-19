import type { LeaderboardEntry } from "@portal/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AsteroidsGame } from "../game/engine";
import type { ControlName, GamePhase, GameResult, HudState } from "../game/types";
import { api, ApiError, unwrap } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { linkProps } from "../lib/router";

const NICKNAME_KEY = "portal.asteroids.nickname";

interface SessionUser {
  id: string;
  email: string;
  name: string;
}

interface SaveResponse {
  score: LeaderboardEntry;
  rank: number;
}

interface SavedState {
  rank: number;
  playerName: string;
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

function formatScore(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(4, "0");
}

export default function PlayScreen({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<AsteroidsGame | null>(null);

  const [phase, setPhase] = useState<GamePhase>("idle");
  const [hud, setHud] = useState<HudState>({ score: 0, lives: 3, level: 1 });
  const [result, setResult] = useState<GameResult | null>(null);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [nickname, setNickname] = useState(() => defaultNickname(user));
  const [saved, setSaved] = useState<SavedState | null>(null);
  const toastTimer = useRef<number | null>(null);

  /** The board, used on this screen only for the player's own best run. */
  const scoresQuery = useQuery({
    queryKey: ["scores"],
    queryFn: async () =>
      unwrap<{ scores: LeaderboardEntry[]; you: { score: number; rank: number } | null }>(
        await api.scores.$get(),
      ),
  });
  const personalBest = scoresQuery.data?.you?.score ?? null;

  const saveScore = useMutation({
    mutationFn: async (input: { score: number; level: number; playerName: string }) =>
      unwrap<SaveResponse>(await api.scores.$post({ json: input })),
    onSuccess: (data) => {
      setSaved({ rank: data.rank, playerName: data.score.playerName });
      try {
        window.localStorage.setItem(NICKNAME_KEY, data.score.playerName);
      } catch {
        // Non-fatal: the nickname just will not be remembered.
      }
      void queryClient.invalidateQueries({ queryKey: ["scores"] });
    },
  });

  // An expired session must not leave a finished run unsaveable with a generic
  // "couldn't save" message: sign out, which drops the player on the sign-in
  // screen with the reason obvious.
  useEffect(() => {
    const error = saveScore.error ?? scoresQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut().then(() => queryClient.clear());
    }
  }, [saveScore.error, scoresQuery.error, queryClient]);

  // One engine per mount. It owns the canvas and the frame loop; React only
  // receives state transitions, so a 60 fps game never re-renders the tree.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const game = new AsteroidsGame(canvas, {
      onHud: setHud,
      onPhaseChange: setPhase,
      onMutedChange: setMuted,
      onToast: (message) => {
        setToast(message);
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 1200);
      },
      onGameOver: (finished) => {
        setResult(finished);
        setSaved(null);
        saveScore.reset();
      },
    });
    gameRef.current = game;

    return () => {
      game.destroy();
      gameRef.current = null;
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
    // The engine is built once per mount on purpose: `saveScore` is a stable
    // mutation object, and rebuilding the engine would restart the game.
  }, []);

  const startRun = useCallback(() => {
    setResult(null);
    setSaved(null);
    saveScore.reset();
    gameRef.current?.start();
  }, [saveScore]);

  const hold = (name: ControlName) => ({
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
  // Only claim "personal best" once the board has actually loaded — otherwise a
  // first-time player is told every run is a record.
  const isNewBest =
    result !== null &&
    scoresQuery.isSuccess &&
    (personalBest === null || result.score > personalBest);

  return (
    <div className="play">
      <canvas
        ref={canvasRef}
        className="play-canvas"
        aria-label="Asteroids playfield"
        onPointerDown={() => gameRef.current?.primaryAction()}
      />

      {phase !== "idle" ? (
        <div className="play-hud" aria-live="off">
          <span className="play-score">{formatScore(hud.score)}</span>
          <span className="play-level">LEVEL {hud.level}</span>
          <span className="play-lives" aria-label={`${hud.lives} ships left`}>
            {Array.from({ length: Math.min(hud.lives, 8) }, (_, index) => (
              <span className="mini-ship" key={index} aria-hidden="true" />
            ))}
          </span>
        </div>
      ) : null}

      <div className="play-corner play-corner--left">
        <a className="corner-button" aria-label="Back to notes" title="Back" {...linkProps("/")}>
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

      {playing ? (
        <div className="play-controls">
          <div className="control-group">
            <button className="control-button" type="button" aria-label="Rotate left" {...hold("left")}>
              <span className="control-glyph">&#9666;</span>
              <span className="control-label">ROTATE</span>
            </button>
            <button
              className="control-button"
              type="button"
              aria-label="Rotate right"
              {...hold("right")}
            >
              <span className="control-glyph">&#9656;</span>
              <span className="control-label">ROTATE</span>
            </button>
          </div>
          <button
            className="control-button control-button--big"
            type="button"
            aria-label="Thrust"
            {...hold("thrust")}
          >
            <span className="control-glyph">&#9650;</span>
            <span className="control-label">THRUST</span>
          </button>
          <button
            className="control-button control-button--big"
            type="button"
            aria-label="Fire"
            {...hold("fire")}
          >
            <span className="control-glyph">&#9679;</span>
            <span className="control-label">FIRE</span>
          </button>
        </div>
      ) : null}

      {phase === "idle" ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h1 className="play-title">ASTEROIDS</h1>
            <p className="play-sub">Rotate, thrust, and shoot the rocks before they shoot you.</p>
            <dl className="play-keys">
              <div>
                <dt>&#8592; &#8594;</dt>
                <dd>rotate</dd>
              </div>
              <div>
                <dt>&#8593;</dt>
                <dd>thrust</dd>
              </div>
              <div>
                <dt>space</dt>
                <dd>fire</dd>
              </div>
              <div>
                <dt>P / M</dt>
                <dd>pause / mute</dd>
              </div>
            </dl>
            <p className="play-sub play-sub--muted">
              On a phone, use the buttons along the bottom.
            </p>
            {personalBest !== null ? (
              <p className="play-best">Your best: {formatScore(personalBest)}</p>
            ) : null}
            <button className="button button--primary play-start" type="button" onClick={startRun}>
              Launch
            </button>
            <a className="link-button" {...linkProps("/scores")}>
              High scores
            </a>
          </div>
        </div>
      ) : null}

      {phase === "paused" ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h2 className="play-title play-title--small">PAUSED</h2>
            <p className="play-sub">
              Score {formatScore(hud.score)} &middot; Level {hud.level}
            </p>
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
            <a className="link-button" {...linkProps("/")}>
              Quit to notes
            </a>
          </div>
        </div>
      ) : null}

      {phase === "over" && result ? (
        <div className="play-overlay">
          <div className="play-panel">
            <h2 className="play-title play-title--small play-title--over">GAME OVER</h2>
            <p className="play-final">
              <span className="play-final-score">{formatScore(result.score)}</span>
              <span className="play-final-meta">LEVEL {result.level}</span>
            </p>
            {isNewBest ? <p className="play-best play-best--new">New personal best</p> : null}

            {saved ? (
              <p className="play-saved" role="status">
                Saved as <strong>{saved.playerName}</strong> &mdash; rank <strong>#{saved.rank}</strong>
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
                      score: result.score,
                      level: result.level,
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
              <a className="link-button" {...linkProps("/scores")}>
                Leaderboard
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
