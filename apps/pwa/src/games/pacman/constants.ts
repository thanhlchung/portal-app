/**
 * The maze, the landmarks, and the tuning constants.
 *
 * The original drew the maze into an offscreen canvas once per level, and that
 * single detail is what this port keeps instead of the mechanism: the wall
 * segments are precomputed as *data* when a level starts and stroked each frame,
 * so the engine needs no `document.createElement` and stays constructible in
 * Node for tests.
 */

export const COLS = 28;
export const ROWS = 31;
/** Tile size in playfield pixels. */
export const T = 16;
export const GAME_W = COLS * T; // 448
export const GAME_H = ROWS * T; // 496

/** `#` wall, `.` dot, `o` power pellet, `-` ghost-house door, ` ` open. */
export const MAP_SRC: readonly string[] = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "     #.##### ## #####.#     ",
  "     #.##          ##.#     ",
  "     #.## ###--### ##.#     ",
  "######.## #      # ##.######",
  "      .   #      #   .      ",
  "######.## #      # ##.######",
  "     #.## ######## ##.#     ",
  "     #.##          ##.#     ",
  "     #.## ######## ##.#     ",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o..##.......  .......##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
];

export type Direction = "up" | "left" | "down" | "right";

/** Ordered by the ghosts' tie-break preference (up first, as the arcade did). */
export const DIRS: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  down: { x: 0, y: 1 },
  right: { x: 1, y: 0 },
};

export const DIR_ORDER: readonly Direction[] = ["up", "left", "down", "right"];

export const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

/** Landmarks, in playfield pixels — the centre of a tile is `tile * T + T/2`. */
export const DOOR_TILE = { c: 13, r: 11 };
export const PEN_CENTER = { x: 13 * T + T / 2, y: 14 * T + T / 2 };
export const PAC_START = { x: 13 * T + T / 2, y: 23 * T + T / 2 };
export const FRUIT_POS = { x: 13 * T + T / 2, y: 17 * T + T / 2 };

export const COLORS = {
  background: "#000000",
  wall: "#2b31d8",
  wallFlash: "#ffffff",
  door: "#ffb8de",
  pellet: "#f2c9a0",
  pac: "#ffdd00",
  frightened: "#2323d8",
  frightenedFlash: "#f4f4ff",
  ghostEyes: "#ffffff",
  ghostPupil: "#2b31d8",
  fruit: "#e21b1b",
  fruitStem: "#3fbf3f",
  popup: "#a8f7ff",
  text: "#ffdd00",
  textDim: "#7b7a93",
} as const;

export interface GhostDefinition {
  name: "blinky" | "pinky" | "inky" | "clyde";
  color: string;
  /** Corner each ghost retreats to while scattering, in tiles. */
  scatter: { c: number; r: number };
  /** Where it waits inside the pen, in pixels. */
  home: { x: number; y: number };
  /** Ticks before it leaves the pen. */
  release: number;
  startOut: boolean;
}

export const GHOST_DEFS: readonly GhostDefinition[] = [
  {
    name: "blinky",
    color: "#ff2f2f",
    scatter: { c: 25, r: 0 },
    home: { x: DOOR_TILE.c * T + T / 2, y: DOOR_TILE.r * T + T / 2 },
    release: 0,
    startOut: true,
  },
  {
    name: "pinky",
    color: "#ffb0dd",
    scatter: { c: 2, r: 0 },
    home: { x: 13 * T + T / 2, y: PEN_CENTER.y },
    release: 60,
    startOut: false,
  },
  {
    name: "inky",
    color: "#38dcff",
    scatter: { c: 27, r: 30 },
    home: { x: 11 * T + T / 2, y: PEN_CENTER.y },
    release: 260,
    startOut: false,
  },
  {
    name: "clyde",
    color: "#ffab4a",
    scatter: { c: 0, r: 30 },
    home: { x: 15 * T + T / 2, y: PEN_CENTER.y },
    release: 520,
    startOut: false,
  },
];

/** Scatter/chase schedule, in seconds. The last chase never ends. */
export const MODE_PLAN: readonly (readonly [mode: "scatter" | "chase", seconds: number])[] = [
  ["scatter", 7],
  ["chase", 20],
  ["scatter", 7],
  ["chase", 20],
  ["scatter", 5],
  ["chase", 20],
  ["scatter", 5],
  ["chase", Infinity],
];

/** Points. */
export const POINTS = { dot: 10, pellet: 50, ghost: 200, fruit: [100, 300, 500, 700, 1000, 2000, 3000, 5000] } as const;

export const STARTING_LIVES = 3;
/** Ticks (60/s) at the original's cadence. */
export const READY_TICKS = 130;
export const DEATH_TICKS = 130;
export const CLEAR_TICKS = 150;
export const FREEZE_TICKS = 36;
export const FRUIT_TICKS = 9 * 60;

/** Speeds, in pixels per tick. */
export const pacSpeed = (level: number): number => 2 + Math.min(level - 1, 4) * 0.06;
export const baseGhostSpeed = (level: number): number => 1.72 + Math.min(level - 1, 5) * 0.05;
export const frightSeconds = (level: number): number => Math.max(2, 8 - (level - 1) * 0.7);
