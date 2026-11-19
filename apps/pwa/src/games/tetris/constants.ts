/**
 * Playfield geometry and tuning.
 *
 * Like Space Invaders, Tetris keeps a fixed logical field and is letterboxed
 * into the canvas, so the board's 10×20 cells are identical at every screen
 * size. The strip along the top is deliberately empty: that is where the
 * shell's DOM HUD (score / level / lines) sits, and the board must not slide
 * underneath it on a phone.
 */

export const GAME_W = 408;
export const GAME_H = 720;

export const COLS = 10;
export const ROWS = 20;
export const CELL = 32;

/** Board origin inside the logical field, below the HUD strip. */
export const BOARD_X = 8;
export const BOARD_Y = 72;
export const BOARD_W = COLS * CELL;
export const BOARD_H = ROWS * CELL;

/** Hold / next preview column, to the right of the board. */
export const PANEL = {
  x: BOARD_X + BOARD_W + 8,
  w: GAME_W - (BOARD_X + BOARD_W + 8) - 8,
  h: 88,
  ys: [BOARD_Y, BOARD_Y + 100, BOARD_Y + 200] as const,
} as const;

/** Seconds. The original expressed these in milliseconds. */
export const LOCK_DELAY = 0.5;
export const CLEAR_TIME = 0.21;
export const SOFT_DROP_INTERVAL = 0.03;
/** Held-direction repeat: a long pause before the first repeat, then fast. */
export const DAS_DELAY = 0.17;
export const DAS_REPEAT = 0.085;

export const SOFT_DROP_POINTS = 1;
export const HARD_DROP_POINTS = 2;
/** Points by number of lines cleared in one placement, before the level multiplier. */
export const LINE_POINTS: Record<number, number> = { 1: 100, 2: 300, 3: 500, 4: 800 };
export const LINES_PER_LEVEL = 10;

/** Colours used for the board furniture (the pieces bring their own). */
export const BOARD_COLORS = {
  background: "#0a0e15",
  border: "rgba(120,170,255,.45)",
  grid: "rgba(255,255,255,.05)",
  panel: "rgba(0,0,0,.35)",
  panelBorder: "rgba(255,255,255,.12)",
  label: "#7f8ea0",
} as const;

/**
 * Gravity: the classic curve, in seconds per row.
 * Level 1 ≈ 1 s, level 10 ≈ 0.065 s, level 15 ≈ 0.022 s.
 */
export function fallInterval(level: number): number {
  const index = Math.max(1, level) - 1;
  return Math.pow(0.8 - index * 0.007, index);
}
