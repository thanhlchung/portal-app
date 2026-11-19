/**
 * The engine's public contract.
 *
 * The simulation is deliberately headless with respect to React: it owns a
 * canvas, runs its own animation loop, and *reports* what happened through
 * callbacks. No React state lives inside the frame loop, so a 60 fps game never
 * re-renders a component tree.
 */

export type GamePhase = "idle" | "playing" | "paused" | "over";

export type ControlName = "left" | "right" | "thrust" | "fire";

export interface HudState {
  score: number;
  lives: number;
  level: number;
}

export interface GameResult {
  score: number;
  level: number;
}

export interface GameEvents {
  /** Score, lives or level changed — cheap enough to fire per change. */
  onHud?: (state: HudState) => void;
  /** Lifecycle transitions the shell draws its own overlays for. */
  onPhaseChange?: (phase: GamePhase) => void;
  /** A run ended. The shell decides whether and how to persist it. */
  onGameOver?: (result: GameResult) => void;
  /** "EXTRA SHIP!" and similar. Rendered by the shell, not on the canvas. */
  onToast?: (message: string) => void;
  /** Mute was toggled from the keyboard, so the shell's button stays in sync. */
  onMutedChange?: (muted: boolean) => void;
}
