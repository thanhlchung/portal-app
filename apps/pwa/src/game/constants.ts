/**
 * Tuning constants, ported from the original single-file game.
 *
 * They live in their own module so the play screen can show the same numbers
 * the simulation uses (for example the extra-ship threshold) without importing
 * the engine, and so a balance change is one edit rather than a hunt through a
 * 900-line file.
 */

export const TAU = Math.PI * 2;

export const SHIP_R = 14;
export const SHIP_ACCEL = 330;
export const SHIP_MAXV = 320;
export const ROT_SPEED = 4.6;
export const BULLET_SPD = 560;
export const BULLET_LIFE = 1.4;
export const BULLET_MAX = 4;
export const FIRE_CD = 0.22;
/** Every 10 000 points grants a ship. */
export const EXTRA_LIFE_AT = 10_000;
export const STARTING_LIVES = 3;

/** One star per this many CSS pixels of playfield. */
export const STAR_AREA_PER_STAR = 4200;

export type AsteroidSize = "large" | "medium" | "small";

export const ASTEROID_SIZES: Record<AsteroidSize, { readonly r: number; readonly pts: number }> = {
  large: { r: 42, pts: 20 },
  medium: { r: 25, pts: 50 },
  small: { r: 12, pts: 100 },
};

export const DIFFICULTY = {
  baseRot: 0.35,
  rotPerLvl: 0.12,
  baseVel: 55,
  velPerLvl: 5.5,
  baseCount: 4,
  countPerLvl: 1,
  maxCount: 12,
} as const;

/** UFO scoring: the small saucer is worth more because it aims better. */
export const UFO_POINTS = { small: 1000, large: 200 } as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The ship's nose points up in local coordinates, but motion and fire use
 * (cos angle, sin angle), so every draw rotates by angle + 90° to line the
 * visible nose up with the direction of travel.
 */
export const SHIP_SHAPE: readonly Point[] = [
  { x: 0, y: -18 },
  { x: 11, y: 11 },
  { x: 0, y: 5 },
  { x: -11, y: 11 },
];

export const FLAME_SHAPE: readonly Point[] = [
  { x: 0, y: 6 },
  { x: 7, y: 20 },
  { x: 0, y: 13 },
  { x: -7, y: 20 },
];
