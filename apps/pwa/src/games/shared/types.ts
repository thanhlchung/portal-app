import type { MatchOutcome } from "@portal/api";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

/**
 * The contract between a game and the arcade shell.
 *
 * A game supplies a *definition*: how to build its engine, which buttons exist,
 * how its HUD and intro look, and how to turn a finished run into something the
 * score API stores. Everything else — canvas lifecycle, pause/game-over
 * overlays, the score-saving panel, mute, toasts, session handling — belongs to
 * the shell, once, so that a second game is an engine plus a definition rather
 * than a copy of a 380-line screen.
 *
 * The two type parameters are what make this honest across different games:
 * `Hud` is whatever that game shows while playing (score/lives/level for
 * Asteroids; score/lines/next-piece for Tetris), and `Result` is whatever it
 * reports when a run ends. The shell never inspects either — it renders what
 * `renderHud` returns and passes `submission()` to the API.
 */

export type GamePhase = "idle" | "playing" | "paused" | "over";

/** The minimum a finished run must report, because `score` and `level` are columns. */
export interface GameResult {
  score: number;
  level: number;
}

export type ScoreSubmission = GameResult;

/**
 * What a finished run reports, and therefore how the shell persists it.
 *
 * Score games produce a number to rank high-to-low. Versus games produce a
 * winner, and inventing a score for them (a "win = 1 point" board) would answer
 * a different question than the one players ask. The union keeps that decision
 * in the game's definition, where the rules live.
 */
export type RunOutcome =
  | ({ kind: "score" } & ScoreSubmission)
  | { kind: "outcome"; outcome: MatchOutcome };

export interface ArcadeEvents<Hud, Result> {
  onHud?: (hud: Hud) => void;
  onPhaseChange?: (phase: GamePhase) => void;
  onGameOver?: (result: Result) => void;
  /** "EXTRA SHIP!" and similar. Rendered by the shell, not on the canvas. */
  onToast?: (message: string) => void;
  onMutedChange?: (muted: boolean) => void;
}

/**
 * What the shell calls on an engine. An engine that satisfies this needs no
 * adapter: `AsteroidsGame` already does.
 */
export interface ArcadeEngine {
  start(): void;
  pause(): void;
  resume(): void;
  togglePause(): void;
  /** Enter/tap while idle or over → start; while paused → resume. */
  primaryAction(): void;
  /** `name` matches a `ControlSpec.name` from the same definition. */
  setInput(name: string, down: boolean): void;
  toggleMute(): void;
  destroy(): void;
  /**
   * Optional: act on a tap on the canvas itself, in CSS pixels relative to the
   * canvas. Returns true when the game consumed it.
   *
   * A board game is played by touching the board, not by pressing a direction
   * pad — this is what lets the shell hand the tap over instead of treating it
   * as "start or resume".
   */
  pointerAt?(x: number, y: number): boolean;
}

export interface ControlSpec {
  /** Engine-side input id, passed straight to `setInput`. */
  name: string;
  glyph: string;
  label: string;
  /** Thumb-sized button, for the two most important controls. */
  big?: boolean;
}

/**
 * The pointer wiring for one on-screen control, produced by the shell.
 *
 * It presses `setInput(name, true)` on pointer-down (with capture, so a release
 * outside the button still arrives) and `false` on every release path. A tap
 * action — rotate, hard drop, hold — is just the rising edge of that flag, which
 * the engine can act on once, so taps and holds share one mechanism.
 */
export interface ControlHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
  onContextMenu(event: ReactMouseEvent): void;
}

export interface IntroContext {
  /** The caller's best score in this game, or null if they have none yet. */
  personalBest: number | null;
}

export interface ArcadeDefinition<Hud, Result> {
  /** Rendered along the bottom while playing. Empty means "keyboard only". */
  controls: readonly ControlSpec[];
  /** Factory, not a class: the shell owns the canvas and the lifecycle. */
  createEngine(canvas: HTMLCanvasElement, events: ArcadeEvents<Hud, Result>): ArcadeEngine;
  /** The playing HUD (score, lives, level…). Rendered only while a run exists. */
  renderHud(hud: Hud): ReactNode;
  /** Optional instructions for the start panel; the shell adds the buttons. */
  renderIntro?(context: IntroContext): ReactNode;
  /**
   * Optional custom layout for the on-screen pad.
   *
   * The default renderer fits `controls` into one row, which is right for two
   * directions and a trigger. A game that needs more (Tetris: move, rotate,
   * soft drop, hard drop, hold) lays out its own pad here using the bindings the
   * shell hands it — the wiring stays the shell's, only the arrangement moves.
   */
  renderControls?(bind: (name: string) => ControlHandlers): ReactNode;
  /** Map a finished run onto the report the API accepts for this game's kind. */
  submission(result: Result): RunOutcome;
}
