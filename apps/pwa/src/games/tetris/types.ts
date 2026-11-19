import type { ArcadeEvents, GamePhase, GameResult } from "../shared/types";

/**
 * Tetris' side of the engine contract: a HUD of score / level / lines, and six
 * inputs (plus a keyboard-only counter-clockwise rotate that has no button).
 */

export type { GamePhase, GameResult };

export const CONTROL_NAMES = ["left", "right", "rotate", "rotateCcw", "down", "hard", "hold"] as const;

export type ControlName = (typeof CONTROL_NAMES)[number];

export interface HudState {
  score: number;
  level: number;
  lines: number;
}

export type GameEvents = ArcadeEvents<HudState, GameResult>;
