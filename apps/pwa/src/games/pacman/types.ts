import type { ArcadeEvents, GamePhase, GameResult } from "../shared/types";

/**
 * Pac-Man's side of the engine contract: a score, a level, lives, and four
 * directions of input.
 *
 * The input is a *request*, not a held state: pressing a direction sets where
 * Pac-Man should turn next, and he keeps going until he hits a wall. That is why
 * `setInput` acts on the press and ignores the release.
 */

export type { GamePhase, GameResult };

export type Direction = "up" | "left" | "down" | "right";

export type ControlName = Direction;

export interface HudState {
  score: number;
  level: number;
  lives: number;
}

export type GameEvents = ArcadeEvents<HudState, GameResult>;
