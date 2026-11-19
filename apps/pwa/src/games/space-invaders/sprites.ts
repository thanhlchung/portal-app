/**
 * The pixel art, straight from the original 8-bit-style source.
 *
 * Sprites are encoded as `#`/`.` text and converted at module load into
 * *horizontal runs* — one rectangle per stretch of filled pixels in a row.
 * The original pre-rendered each sprite into an offscreen canvas; runs get most
 * of that win without a canvas, which matters here because the engine must be
 * constructible in Node for tests (no `document.createElement`).
 */

/** One filled horizontal stretch, in sprite-local pixels. */
export interface PixelRun {
  x: number;
  y: number;
  w: number;
}

export interface Sprite {
  w: number;
  h: number;
  runs: readonly PixelRun[];
}

export function spriteFrom(rows: readonly string[], pixel: number): Sprite {
  const cols = rows[0]?.length ?? 0;
  const runs: PixelRun[] = [];

  rows.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const filled = row[x] === "#";
      if (filled && start === -1) start = x;
      if (!filled && start !== -1) {
        runs.push({ x: start * pixel, y: y * pixel, w: (x - start) * pixel });
        start = -1;
      }
    }
  });

  return { w: cols * pixel, h: rows.length * pixel, runs };
}

const SQUID_A = [
  "...##...",
  "..####..",
  ".######.",
  "##.##.##",
  "########",
  "..#..#..",
  ".#.##.#.",
  "#.#..#.#",
];

const SQUID_B = [
  "...##...",
  "..####..",
  ".######.",
  "##.##.##",
  "########",
  ".#.##.#.",
  "#......#",
  ".#....#.",
];

const CRAB_A = [
  "..#.....#..",
  "...#...#...",
  "..#######..",
  ".##.###.##.",
  "###########",
  "#.#######.#",
  "#.#.....#.#",
  "...##.##...",
];

const CRAB_B = [
  "..#.....#..",
  "#..#...#..#",
  "#.#######.#",
  "###.###.###",
  "###########",
  ".#########.",
  "..#.....#..",
  ".#.......#.",
];

const OCTOPUS_A = [
  "....####....",
  ".##########.",
  "############",
  "###..##..###",
  "############",
  "...##..##...",
  "..##.##.##..",
  "##........##",
];

const OCTOPUS_B = [
  "....####....",
  ".##########.",
  "############",
  "###..##..###",
  "############",
  "..###..###..",
  ".##..##..##.",
  "..##....##..",
];

const PLAYER = [
  "......#......",
  ".....###.....",
  ".....###.....",
  ".###########.",
  "#############",
  "#############",
  "#############",
  "#############",
];

const UFO = [
  ".....######.....",
  "...##########...",
  "..############..",
  ".##############.",
  "###..###..######",
  "####..###..#####",
  "###......#######",
];

/** Shield silhouette. Cells are 4 px, so one shield is 60 × 32. */
export const SHIELD_SHAPE = [
  "....######....",
  "...########...",
  "..##########..",
  ".############.",
  "###############",
  "###############",
  "###############",
  "###############",
];

/** Sprite pixel size: invaders, player and UFO are drawn at 3× their art. */
export const SPRITE_PIXEL = 3;

/** `[type][frame]`. Type 0 is the top row (squid), 1 the middle, 2 the bottom. */
export const INVADER_SPRITES: readonly (readonly [Sprite, Sprite])[] = [
  [spriteFrom(SQUID_A, SPRITE_PIXEL), spriteFrom(SQUID_B, SPRITE_PIXEL)],
  [spriteFrom(CRAB_A, SPRITE_PIXEL), spriteFrom(CRAB_B, SPRITE_PIXEL)],
  [spriteFrom(OCTOPUS_A, SPRITE_PIXEL), spriteFrom(OCTOPUS_B, SPRITE_PIXEL)],
];

export const PLAYER_SPRITE = spriteFrom(PLAYER, SPRITE_PIXEL);
/** The gun barrel is drawn white over the green hull. */
export const PLAYER_TIP_SPRITE = spriteFrom(PLAYER.slice(0, 3), SPRITE_PIXEL);
export const UFO_SPRITE = spriteFrom(UFO, SPRITE_PIXEL);
