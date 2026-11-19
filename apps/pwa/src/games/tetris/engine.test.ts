/**
 * Headless tests for the Tetris simulation.
 *
 * The rules worth proving are the ones a player would notice only after a bad
 * surprise: a piece that locks early, a line that does not clear, a spawn that
 * does not top out, hold that can be used twice, and a bag that is not a bag.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeCanvas, listenerCount, resetHarness, step } from "../shared/testHarness";
import { TetrisGame } from "./engine";
import { TYPES, type PieceType } from "./pieces";
import type { GameEvents } from "./types";

interface TestPiece {
  type: PieceType;
  x: number;
  y: number;
  rot: number;
  cells: { x: number; y: number }[];
}

interface Internals {
  phase: string;
  score: number;
  lines: number;
  level: number;
  grid: (PieceType | null)[][];
  current: TestPiece | null;
  heldType: PieceType | null;
  canHold: boolean;
  queue: PieceType[];
  clearRows: number[];
  makePiece(type: PieceType, rot: number): TestPiece;
  spawnPiece(): void;
  addScoreForClear(count: number): void;
  nextType(): PieceType;
  input: Record<string, boolean>;
}

function internalsOf(game: TetrisGame): Internals {
  return game as unknown as Internals;
}

function makeGame(events: GameEvents = {}): TetrisGame {
  return new TetrisGame(fakeCanvas(), events);
}

function filledCells(game: TetrisGame): number {
  return internalsOf(game).grid.flat().filter(Boolean).length;
}

let game: TetrisGame;

beforeEach(() => {
  resetHarness();
  game = makeGame();
});

afterEach(() => {
  game.destroy();
});

describe("tetris engine", () => {
  it("idles until a run is started", () => {
    assert.equal(game.currentPhase, "idle");
    step(2);
    assert.equal(game.currentPhase, "idle");
  });

  it("starts with an empty 10×20 board and a piece at the top", () => {
    game.start();
    assert.equal(game.currentPhase, "playing");
    assert.deepEqual(game.hud, { score: 0, level: 1, lines: 0 });

    const internals = internalsOf(game);
    assert.equal(internals.grid.length, 20);
    assert.equal(internals.grid[0]?.length, 10);
    assert.equal(filledCells(game), 0);

    const piece = internals.current;
    assert.ok(piece, "a piece should be falling");
    assert.ok(TYPES.includes(piece.type));
    assert.equal(piece.rot, 0);
    // Spawns above the board, horizontally centred for its width.
    assert.ok(piece.y <= 0);
    assert.ok(piece.x >= 2 && piece.x <= 5, `unexpected spawn column ${piece.x}`);
  });

  it("rotates a piece and comes back around after four turns", () => {
    game.start();
    const internals = internalsOf(game);
    // A T piece participates in SRS kicks; O would ignore rotation entirely.
    internals.current = internals.makePiece("T", 0);

    for (let turn = 0; turn < 4; turn += 1) {
      const beforeRot: number = internals.current!.rot;
      game.setInput("rotate", true);
      step(1);
      game.setInput("rotate", false);
      step(1);
      assert.equal(internals.current!.rot, (beforeRot + 1) % 4);
    }
    assert.equal(internals.current!.rot, 0);
  });

  it("locks a hard-dropped piece into the board and spawns the next one", () => {
    game.start();
    const internals = internalsOf(game);

    game.setInput("hard", true);
    step(1);
    game.setInput("hard", false);

    assert.equal(filledCells(game), 4, "the dropped piece should be settled");
    assert.ok(internals.score > 0, "hard drop awards points per cell");
    assert.ok(internals.current, "a new piece should be falling");
    // The settled cells sit at the bottom of the board.
    assert.ok(internals.grid[19]?.some(Boolean));
  });

  it("clears a completed line and scores it", () => {
    game.start();
    const internals = internalsOf(game);

    // Nine cells of the bottom row, with a gap in columns 0–1 for the O piece.
    const row = internals.grid[19]!;
    for (let col = 2; col < 10; col += 1) row[col] = "I";
    // Park an O piece in the gap, resting on the floor.
    const piece = internals.makePiece("O", 0);
    piece.x = 0;
    piece.y = 18;
    internals.current = piece;

    // 0.5s lock delay + 0.21s clear animation, with headroom.
    step(60);

    assert.equal(internals.lines, 1);
    assert.equal(internals.score, 100, "a single line is 100 × level");
    assert.equal(internals.grid.length, 20, "the board keeps twenty rows");
    // The full row is gone: every I cell was on it, and only the two O cells
    // from the row above survive (shifted down into the bottom row).
    assert.equal(internals.grid.flat().filter((cell) => cell === "I").length, 0);
    assert.equal(filledCells(game), 2);
    assert.equal(game.currentPhase, "playing");
  });

  it("ends the run when a new piece cannot spawn", () => {
    const results: { score: number; level: number }[] = [];
    const blocked = makeGame({ onGameOver: (result) => results.push(result) });
    blocked.start();

    const internals = internalsOf(blocked);
    // Fill the two spawn rows, then try to spawn into them.
    for (const index of [0, 1]) internals.grid[index] = new Array<PieceType | null>(10).fill("I");
    internals.spawnPiece();

    assert.equal(blocked.currentPhase, "over");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.score, 0);

    blocked.destroy();
  });

  it("allows hold once per piece", () => {
    game.start();
    const internals = internalsOf(game);
    const first = internals.current!.type;

    game.setInput("hold", true);
    step(1);
    game.setInput("hold", false);
    step(1);

    assert.equal(internals.heldType, first, "the piece should be in the hold slot");
    assert.notEqual(internals.current!.type, first, "a different piece should be active");
    assert.equal(internals.canHold, false);

    const held = internals.heldType;
    const active = internals.current!.type;
    game.setInput("hold", true);
    step(1);
    game.setInput("hold", false);
    step(1);

    assert.equal(internals.heldType, held, "hold cannot be used twice in a row");
    assert.equal(internals.current!.type, active);
  });

  it("soft drops for a point per cell", () => {
    game.start();
    const internals = internalsOf(game);
    const startY = internals.current!.y;

    game.setInput("down", true);
    step(8); // ~0.13s at one cell per 30ms
    game.setInput("down", false);

    assert.ok(internals.current!.y > startY, "the piece should have descended");
    assert.ok(internals.score > 0, "soft drop awards a point per cell");
  });

  it("raises the level every ten lines", () => {
    game.start();
    const internals = internalsOf(game);

    internals.addScoreForClear(4);
    internals.addScoreForClear(4);
    assert.equal(internals.level, 1);
    assert.equal(internals.lines, 8);

    internals.addScoreForClear(4);
    assert.equal(internals.lines, 12);
    assert.equal(internals.level, 2);
  });

  it("deals all seven pieces in each bag", () => {
    game.start();
    const internals = internalsOf(game);
    internals.queue = [];

    const drawn = new Set<PieceType>();
    for (let i = 0; i < 7; i += 1) drawn.add(internals.nextType());

    assert.equal(drawn.size, 7, "a 7-bag must contain each piece exactly once");
  });

  it("freezes while paused and resumes", () => {
    game.start();
    const internals = internalsOf(game);
    game.setInput("down", true);
    step(4);
    const frozen = internals.current!.y;

    game.pause();
    assert.equal(game.currentPhase, "paused");
    step(20);
    assert.equal(internals.current!.y, frozen, "a paused piece must not fall");
    // Held inputs are dropped on pause, so it must not resume falling either.
    game.resume();
    assert.equal(game.currentPhase, "playing");
    step(10);
    assert.equal(internals.current!.y, frozen, "the pause should have released the key");

    game.setInput("down", true);
    step(10);
    assert.ok(internals.current!.y > frozen);
  });

  it("ignores an unknown control name", () => {
    game.start();
    assert.doesNotThrow(() => game.setInput("teleport", true));
  });

  it("stops listening to the window once destroyed", () => {
    const before = listenerCount("keydown");
    assert.ok(before > 0);
    game.destroy();
    assert.equal(listenerCount("keydown"), before - 1);
  });
});
