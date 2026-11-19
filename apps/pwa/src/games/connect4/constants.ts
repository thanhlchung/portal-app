/**
 * Geometry for a 7×6 board drawn in a fixed logical field, letterboxed into the
 * canvas like the other games. The strip at the top is reserved for the shell's
 * DOM HUD; the strip at the bottom is where a thumb lands.
 */

export const GAME_W = 420;
export const GAME_H = 520;

export const COLS = 7;
export const ROWS = 6;
export const CELL = 56;

export const BOARD_W = COLS * CELL;
export const BOARD_H = ROWS * CELL;
export const BOARD_X = (GAME_W - BOARD_W) / 2;
export const BOARD_Y = 104;

/** Taps this far above the board still pick a column: the natural aim area. */
export const AIM_MARGIN = 80;

export const COLORS = {
  background: "#0a0e1c",
  frame: "#2b5ce0",
  frameEdge: "rgba(255,255,255,.25)",
  hole: "#04081c",
  you: "#ff3b30",
  computer: "#ffd60a",
  winRing: "#ffffff",
  invalid: "rgba(255,80,80,.55)",
} as const;

/** Seconds. The original animated the drop with CSS transitions. */
export const FALL_TIME = 0.28;
export const AI_THINK_DELAY = 0.38;
export const INVALID_COLUMN_TIME = 0.35;

/** AI difficulty: depth and time budget, mirroring the original's presets. */
export const DIFFICULTY = {
  easy: { depth: 2, budget: 400, random: 0.35 },
  medium: { depth: 5, budget: 600, random: 0.15 },
  hard: { depth: 10, budget: 800, random: 0 },
} as const;

export type Difficulty = keyof typeof DIFFICULTY;
