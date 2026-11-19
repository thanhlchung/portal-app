import { PLAYER_SPRITE } from "./sprites";

/**
 * Tuning, matching the original's playfield.
 *
 * The game keeps its fixed 640×720 logical resolution and is letterboxed into
 * whatever canvas the shell gives it. That is deliberate: everything below is
 * expressed in those units, and scaling at draw time keeps the collision
 * arithmetic identical to the original at every screen size.
 */

export const GAME_W = 640;
export const GAME_H = 720;

export const COLORS = {
  invader: ["#66ff66", "#ffff66", "#66ffff"] as const,
  player: "#33ff66",
  ufo: "#ff3366",
  shield: "#00e04a",
  bullet: "#ffffff",
  alienBullet: "#ff6ec7",
} as const;

/** Points by invader type: top row is worth the most (it is hardest to reach). */
export const INVADER_POINTS = [30, 20, 10] as const;
/** The mystery UFO is worth one of these, chosen at random when it is hit. */
export const UFO_POINTS = [50, 100, 150, 300] as const;

export const BOARD = {
  rows: 5,
  cols: 11,
  /** Column spacing, and the horizontal start of the fleet. */
  hspace: 40,
  vspace: 26,
  startX: Math.round((640 - (11 - 1) * 40) / 2),
  startY: 56,
} as const;

export const PLAYER = {
  y: 652,
  speed: 240,
  /** Sideways wall gap. */
  margin: 2,
  w: PLAYER_SPRITE.w,
  h: PLAYER_SPRITE.h,
  fireCooldown: 0.22,
  maxBullets: 2,
  bulletW: 3,
  bulletH: 12,
  bulletSpeed: -520,
} as const;

export const ALIEN_BULLET = { w: 3, h: 10 } as const;

export const FLEET = {
  step: 6,
  drop: 14,
  margin: 4,
} as const;

export const SHIELD = {
  xs: [40, 210, 372, 534] as const,
  y: 548,
  /** Cell size in playfield pixels. */
  cell: 4,
  /** Radius of the hole a bullet carves, in cells. */
  blastCells: 2,
} as const;

export const UFO = {
  y: 44,
  /** Base speed; the fleet's level adds to it. */
  speed: 90,
  speedPerLevel: 8,
  /** Seconds to the first UFO after a level starts, then the spawn window. */
  firstDelay: 6,
  spawnMin: 18,
  spawnMax: 32,
  warbleInterval: 0.12,
} as const;

/** A cleared fleet waits this long before the next wave (the level banner). */
export const LEVEL_CLEAR_DELAY = 1.2;

export const EXTRA_LIFE_AT = 5000;
export const MAX_LIVES = 6;
export const STARTING_LIVES = 3;

/** The classic four-note march, one note per fleet step. */
export const MARCH_NOTES = [110, 98, 92, 82] as const;

export const STAR_COUNT = 90;
