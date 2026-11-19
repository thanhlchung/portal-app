import type { ArcadeEvents, GamePhase } from "../shared/types";

/**
 * Connect 4's side of the engine contract.
 *
 * A match has a winner, not a score, so the result is an outcome from the
 * human's point of view — that is what the versus board aggregates.
 */

export type { GamePhase };

export type Disc = 1 | 2; // 1 = you (red), 2 = the computer (yellow)

export type MatchOutcome = "win" | "loss" | "draw";

export interface VersusResult {
  outcome: MatchOutcome;
}

export interface HudState {
  turn: "you" | "computer" | "over";
  wins: number;
  losses: number;
  draws: number;
}

export type GameEvents = ArcadeEvents<HudState, VersusResult>;
