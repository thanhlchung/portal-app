import type { LeaderboardEntry, VersusRecord } from "@portal/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, unwrap } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { linkProps } from "../../lib/router";
import type { GameMeta, SessionUser } from "../registry";
import { formatScore } from "./format";
import type {
  ArcadeDefinition,
  ArcadeEngine,
  ControlHandlers,
  GamePhase,
  RunOutcome,
} from "./types";

/**
 * The arcade shell: everything a game should not have to think about.
 *
 * It owns the canvas and the engine's lifecycle, the HUD frame, the touch
 * controls, the start/paused/game-over overlays, the result-saving panel
 * (query, mutation, rank, nickname, 401 handling) and the links between `/play`
 * and `/play/<slug>/scores`.
 *
 * Two kinds of game share it, and the difference is deliberately narrow: a
 * **score** game posts a number and is ranked high-to-low; a **versus** game
 * posts a win/loss/draw and is ranked by wins. The definition says which, in
 * `submission()`, and the shell branches only on that.
 *
 * The frame loop stays *outside* React: the engine reports events, which set
 * state, which re-renders the shell — but the per-frame work never touches the
 * component tree.
 */

const NICKNAME_KEY = "portal.nickname";

interface ScoreBoard {
  kind: "score";
  scores: LeaderboardEntry[];
  you: { score: number; rank: number } | null;
}

interface VersusBoard {
  kind: "versus";
  records: VersusRecord[];
  you: VersusRecord | null;
}

type BoardPayload = ScoreBoard | VersusBoard;

interface SavedInfo {
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

function outcomeTitle(outcome: "win" | "loss" | "draw"): string {
  if (outcome === "win") return "YOU WIN";
  if (outcome === "loss") return "YOU LOSE";
  return "DRAW";
}

function outcomeClass(outcome: "win" | "loss" | "draw"): string {
  if (outcome === "win") return "play-title--win";
  if (outcome === "loss") return "play-title--over";
  return "play-title--draw";
}

export function ArcadeShell<Hud, Result, Engine extends ArcadeEngine = ArcadeEngine>({
  game,
  user,
  definition,
}: {
  game: GameMeta;
  user: SessionUser;
  definition: ArcadeDefinition<Hud, Result, Engine>;
}) {
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Engine | null>(null);
  /** The same engine, as state, so a game's settings UI can configure it. */
  const [engine, setEngine] = useState<Engine | null>(null);

  const [phase, setPhase] = useState<GamePhase>("idle");
  const [hud, setHud] = useState<Hud | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [nickname, setNickname] = useState(() => defaultNickname(user));
  const [saved, setSaved] = useState<SavedInfo | null>(null);
  const toastTimer = useRef<number | null>(null);

  /** This player's standing in this game — a best score, or a match record. */
  const boardQuery = useQuery({
    queryKey: ["scores", game.slug],
    queryFn: async (): Promise<BoardPayload> =>
      game.kind === "versus"
        ? unwrap<VersusBoard>(
            await api.games[":slug"].matches.$get({ param: { slug: game.slug } }),
          )
        : unwrap<ScoreBoard>(await api.games[":slug"].scores.$get({ param: { slug: game.slug } })),
  });

  const board = boardQuery.data;
  const myScore = board?.kind === "score" ? board.you : null;
  const myRecord = board?.kind === "versus" ? board.you : null;

  const report = useMutation({
    mutationFn: async (input: { playerName: string; outcome: RunOutcome }): Promise<SavedInfo> => {
      if (input.outcome.kind === "score") {
        const data = await unwrap<{ score: { playerName: string }; rank: number }>(
          await api.games[":slug"].scores.$post({
            param: { slug: game.slug },
            json: {
              score: input.outcome.score,
              level: input.outcome.level,
              playerName: input.playerName,
            },
          }),
        );
        return { rank: data.rank, playerName: data.score.playerName };
      }

      const data = await unwrap<{ record: { playerName: string } | null; rank: number | null }>(
        await api.games[":slug"].matches.$post({
          param: { slug: game.slug },
          json: { outcome: input.outcome.outcome, playerName: input.playerName },
        }),
      );
      return {
        rank: data.rank ?? 0,
        playerName: data.record?.playerName ?? input.playerName,
      };
    },
    onSuccess: (data) => {
      setSaved(data);
      try {
        window.localStorage.setItem(NICKNAME_KEY, data.playerName);
      } catch {
        // Non-fatal: the nickname just will not be remembered.
      }
      // Both the board and the hub summary (which shows every game's standing)
      // are stale now.
      void queryClient.invalidateQueries({ queryKey: ["scores"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });

  // An expired session must not leave a finished run unsaveable with a generic
  // "couldn't save" message: sign out, which drops the player on sign-in.
  useEffect(() => {
    const error = report.error ?? boardQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut().then(() => queryClient.clear());
    }
  }, [report.error, boardQuery.error, queryClient]);

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
        report.reset();
      },
      onToast: (message) => {
        setToast(message);
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 1200);
      },
    });
    gameRef.current = engine;
    setEngine(engine);

    return () => {
      engine.destroy();
      gameRef.current = null;
      setEngine(null);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
    // `report` is a stable mutation object; the engine must not be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, game.slug]);

  const startRun = useCallback(() => {
    setResult(null);
    setSaved(null);
    report.reset();
    gameRef.current?.start();
  }, [report]);

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
  const outcome = result === null ? null : definition.submission(result);
  // Only claim "personal best" once the board has actually loaded — otherwise a
  // first-time player is told every run is a record.
  const isNewBest =
    outcome?.kind === "score" &&
    boardQuery.isSuccess &&
    (myScore === null || outcome.score > myScore.score);

  const personalLine =
    myScore !== null
      ? `Your best: ${formatScore(myScore.score)}`
      : myRecord !== null
        ? `Your record: ${myRecord.wins}W · ${myRecord.losses}L · ${myRecord.draws}D`
        : null;

  const boardLabel = game.kind === "versus" ? "Records" : "High scores";

  return (
    <div className="play">
      <canvas
        ref={canvasRef}
        className="play-canvas"
        aria-label={`${game.title} playfield`}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          // A board game consumes taps on the playfield itself; for the rest,
          // a tap means "start" or "resume".
          if (gameRef.current?.pointerAt?.(x, y)) return;
          gameRef.current?.primaryAction();
        }}
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
        <div className="play-controls play-controls--custom">{definition.renderControls(hold)}</div>
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
            {definition.renderIntro?.({ personalBest: myScore?.score ?? null })}
            {definition.renderSettings?.({ engine })}
            {definition.controls.length > 0 ? (
              <p className="play-sub play-sub--muted">
                On a phone, use the buttons along the bottom.
              </p>
            ) : (
              <p className="play-sub play-sub--muted">{game.controls} to play.</p>
            )}
            {personalLine !== null ? <p className="play-best">{personalLine}</p> : null}
            <button className="button button--primary play-start" type="button" onClick={startRun}>
              Launch
            </button>
            <a className="link-button" {...linkProps(`/play/${game.slug}/scores`)}>
              {boardLabel}
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

      {phase === "over" && outcome ? (
        <div className="play-overlay">
          <div className="play-panel">
            {outcome.kind === "score" ? (
              <>
                <h2 className="play-title play-title--small play-title--over">GAME OVER</h2>
                <p className="play-final">
                  <span className="play-final-score">{formatScore(outcome.score)}</span>
                  <span className="play-final-meta">LEVEL {outcome.level}</span>
                </p>
                {isNewBest ? <p className="play-best play-best--new">New personal best</p> : null}
              </>
            ) : (
              <>
                <h2 className={`play-title play-title--small ${outcomeClass(outcome.outcome)}`}>
                  {outcomeTitle(outcome.outcome)}
                </h2>
                <p className="play-final">
                  <span className="play-final-meta">{game.title} · match over</span>
                </p>
              </>
            )}

            {saved ? (
              <p className="play-saved" role="status">
                Saved as <strong>{saved.playerName}</strong>
                {saved.rank > 0 ? (
                  <>
                    {" — "}rank <strong>#{saved.rank}</strong>
                  </>
                ) : null}
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
                  disabled={!nickname.trim() || report.isPending}
                  onClick={() => report.mutate({ playerName: nickname.trim(), outcome })}
                >
                  {report.isPending
                    ? "Saving…"
                    : outcome.kind === "score"
                      ? "Save score"
                      : "Save result"}
                </button>
                {report.isError ? (
                  <p className="form-error" role="alert">
                    Couldn&apos;t save that result. Check your connection and try again.
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
                {boardLabel}
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
