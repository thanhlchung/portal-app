/**
 * The seven pieces, their colours, and the SRS rotation-kick tables.
 *
 * Kicks are the reason rotation "just works" against a wall or another piece:
 * each rotation tries the offsets in order and takes the first that fits. The
 * tables are transcribed from the original build, including the `yUp`
 * convention — a kick of `[x, yUp]` means "move yUp *up*", so the engine negates
 * it when applying to screen coordinates.
 */

export type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export interface Cell {
  x: number;
  y: number;
}

export const TYPES: readonly PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

export const COLORS: Record<PieceType, string> = {
  I: "#00e5ff",
  O: "#ffe600",
  T: "#b45cff",
  S: "#35e06a",
  Z: "#ff4d6d",
  J: "#4d90ff",
  L: "#ff9f43",
};

/** Spawn matrices. Rotation is applied to a copy, never to these. */
export const SHAPES: Record<PieceType, readonly (readonly number[])[]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
};

/** Filled cells of a matrix, in piece-local coordinates. */
export function cellsFromMatrix(matrix: readonly (readonly number[])[]): Cell[] {
  const cells: Cell[] = [];
  matrix.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value) cells.push({ x, y });
    });
  });
  return cells;
}

/** `direction` +1 is clockwise, -1 counter-clockwise. */
export function rotateMatrix(
  matrix: readonly (readonly number[])[],
  direction: number,
): number[][] {
  const size = matrix.length;
  const rotated: number[][] = Array.from({ length: size }, () => new Array(size).fill(0) as number[]);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const source = matrix[row];
      if (!source) continue;
      // Straight from the original: index arithmetic per direction.
      const value = direction > 0 ? matrix[size - 1 - col]?.[row] : matrix[col]?.[size - 1 - row];
      const target = rotated[row];
      if (target) target[col] = value ?? 0;
    }
  }
  return rotated;
}

const JLSTZ: Record<string, readonly (readonly [number, number])[]> = {
  "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const I_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

const NO_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  "0>1": [[0, 0]],
  "1>0": [[0, 0]],
  "1>2": [[0, 0]],
  "2>1": [[0, 0]],
  "2>3": [[0, 0]],
  "3>2": [[0, 0]],
  "3>0": [[0, 0]],
  "0>3": [[0, 0]],
};

export const KICKS: Record<PieceType, Record<string, readonly (readonly [number, number])[]>> = {
  I: I_KICKS,
  O: NO_KICKS,
  J: JLSTZ,
  L: JLSTZ,
  S: JLSTZ,
  T: JLSTZ,
  Z: JLSTZ,
};
