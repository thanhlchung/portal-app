/**
 * Asteroids' side of the engine contract.
 *
 * The lifecycle and reporting shapes are shared with every other game
 * (`games/shared/types.ts`); what is *this* game's is the HUD it shows and the
 * inputs it accepts.
 */

import type { ArcadeEvents, GamePhase, GameResult } from "../shared/types";

export type { GamePhase, GameResult };

export type ControlName = "left" | "right" | "thrust" | "fire";

export interface HudState {
  score: number;
  lives: number;
  level: number;
}

export type GameEvents = ArcadeEvents<HudState, GameResult>;
