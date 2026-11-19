import type { ArcadeEvents, GamePhase, GameResult } from "../shared/types";

/**
 * Space Invaders' side of the engine contract. Everything lifecycle-shaped is
 * shared (`games/shared/types.ts`); what is this game's is its HUD and inputs —
 * two directions and a trigger.
 */

export type { GamePhase, GameResult };

export type ControlName = "left" | "right" | "fire";

export interface HudState {
  score: number;
  lives: number;
  level: number;
}

export type GameEvents = ArcadeEvents<HudState, GameResult>;
