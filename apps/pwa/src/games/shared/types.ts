import type { ReactNode } from "react";

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
}

export interface ControlSpec {
  /** Engine-side input id, passed straight to `setInput`. */
  name: string;
  glyph: string;
  label: string;
  /** Thumb-sized button, for the two most important controls. */
  big?: boolean;
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
  /** Map this game's result onto the two columns the API stores. */
  submission(result: Result): ScoreSubmission;
}
