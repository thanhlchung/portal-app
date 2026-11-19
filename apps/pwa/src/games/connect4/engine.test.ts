/**
 * Headless tests for Connect 4.
 *
 * The interesting behaviours are the ones a player would notice as unfair or
 * broken: a disc landing in the wrong row, four-in-a-row not being seen, the
 * computer missing a win or a block, and a full column accepting a disc.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeCanvas, listenerCount, resetHarness, step } from "../shared/testHarness";
import { BOARD_X, BOARD_Y, CELL, COLS, ROWS } from "./constants";
import { Connect4Game } from "./engine";
import type { GameEvents } from "./types";

type Cell = 0 | 1 | 2;

interface Internals {
  phase: string;
  board: Cell[][];
  current: 1 | 2;
  wins: number;
  losses: number;
  draws: number;
  falling: unknown;
  invalidColumn: number;
  difficulty: string;
  setDifficulty(level: string): void;
  chooseAiColumn(): number;
  playHumanMove(col: number): void;
  finish(outcome: "win" | "loss" | "draw"): void;
}

function internalsOf(game: Connect4Game): Internals {
  return game as unknown as Internals;
}

function makeGame(events: GameEvents = {}): Connect4Game {
  return new Connect4Game(fakeCanvas(), events);
}

/** A canvas point inside a column, using the engine's own letterbox transform. */
function pointFor(game: Connect4Game, col: number): { x: number; y: number } {
  const internals = game as unknown as { scale: number; offsetX: number; offsetY: number };
  const logicalX = BOARD_X + col * CELL + CELL / 2;
  const logicalY = BOARD_Y + CELL * 2;
  return {
    x: logicalX * internals.scale + internals.offsetX,
    y: logicalY * internals.scale + internals.offsetY,
  };
}

let game: Connect4Game;

beforeEach(() => {
  resetHarness();
  game = makeGame();
});

afterEach(() => {
  game.destroy();
});

describe("connect 4 engine", () => {
  it("idles until a run is started", () => {
    assert.equal(game.currentPhase, "idle");
    step(2);
    assert.equal(game.currentPhase, "idle");
  });

  it("starts with an empty 7×6 board and the human to move", () => {
    game.start();
    assert.equal(game.currentPhase, "playing");

    const internals = internalsOf(game);
    assert.equal(internals.board.length, ROWS);
    assert.equal(internals.board[0]?.length, COLS);
    assert.equal(internals.board.flat().filter(Boolean).length, 0);
    assert.equal(internals.current, 1);
    assert.deepEqual(game.hud, {
      turn: "you",
      difficulty: "medium",
      wins: 0,
      losses: 0,
      draws: 0,
    });
  });

  it("drops a tapped disc to the bottom of that column", () => {
    game.start();
    const internals = internalsOf(game);
    const point = pointFor(game, 3);

    assert.equal(game.pointerAt(point.x, point.y), true, "the tap should be consumed");
    // Let the fall animation finish.
    step(25);

    assert.equal(internals.board[ROWS - 1]?.[3], 1, "disc should rest on the floor");
    // The turn passes to the computer once the drop resolves.
    assert.equal(internals.current, 2);
  });

  it("ignores a tap outside the board", () => {
    game.start();
    assert.equal(game.pointerAt(2, 2), false);
    assert.equal(internalsOf(game).board.flat().filter(Boolean).length, 0);
  });

  it("refuses a disc in a full column", () => {
    game.start();
    const internals = internalsOf(game);
    for (let row = 0; row < ROWS; row += 1) {
      const line = internals.board[row];
      if (line) line[5] = 1;
    }

    internals.playHumanMove(5);

    assert.equal(internals.falling, null, "no disc should be in flight");
    assert.equal(internals.invalidColumn, 5, "the column should be flagged as full");
  });

  it("sees four in a row and ends the match as a win", () => {
    const results: string[] = [];
    const playable = makeGame({ onGameOver: (result) => results.push(result.outcome) });
    playable.start();
    const internals = internalsOf(playable);

    // Three red discs on the floor, a gap in column 3.
    const floor = internals.board[ROWS - 1];
    assert.ok(floor);
    floor[0] = 1;
    floor[1] = 1;
    floor[2] = 1;
    internals.current = 1;

    const point = pointFor(playable, 3);
    playable.pointerAt(point.x, point.y);
    step(25);

    assert.equal(playable.currentPhase, "over");
    assert.equal(internals.wins, 1);
    assert.deepEqual(results, ["win"]);
    assert.equal(playable.hud.turn, "over");

    playable.destroy();
  });

  it("records a draw as an outcome", () => {
    const results: string[] = [];
    const playable = makeGame({ onGameOver: (result) => results.push(result.outcome) });
    playable.start();
    const internals = internalsOf(playable);

    internals.finish("draw");
    // A finished match cannot be finished twice.
    internals.finish("loss");

    assert.deepEqual(results, ["draw"]);
    assert.equal(internals.draws, 1);

    playable.destroy();
  });

  it("takes an immediate win", () => {
    game.start();
    const internals = internalsOf(game);
    // Two yellow discs stacked in column 2 with room for a third.
    const [r5, r4, r3] = [internals.board[5], internals.board[4], internals.board[3]];
    assert.ok(r5 && r4 && r3);
    r5[2] = 2;
    r4[2] = 2;
    r3[2] = 2;

    assert.equal(internals.chooseAiColumn(), 2);
  });

  it("blocks the human's immediate win", () => {
    game.start();
    const internals = internalsOf(game);
    const [r5, r4, r3] = [internals.board[5], internals.board[4], internals.board[3]];
    assert.ok(r5 && r4 && r3);
    r5[4] = 1;
    r4[4] = 1;
    r3[4] = 1;

    assert.equal(internals.chooseAiColumn(), 4);
  });

  it("plays the computer's move after the human's drop", () => {
    game.start();
    const internals = internalsOf(game);
    // Easy keeps the search tiny; this test is about the turn plumbing, not chess.
    game.setDifficulty("easy");

    const point = pointFor(game, 3);
    game.pointerAt(point.x, point.y);
    // Fall animation (~0.28s) + the computer's think delay (~0.38s) + finish.
    step(70);

    const discs = internals.board.flat().filter(Boolean);
    assert.equal(discs.length, 2, "the computer should have replied");
    assert.equal(discs.filter((cell) => cell === 2).length, 1);
    assert.equal(internals.current, 1, "it should be the human's turn again");
  });

  it("does not move while paused, and resumes the computer's turn", () => {
    game.start();
    const internals = internalsOf(game);
    game.setDifficulty("easy");

    const point = pointFor(game, 0);
    game.pointerAt(point.x, point.y);
    step(20); // human disc lands, computer is now thinking

    game.pause();
    const frozen = internals.board.flat().filter(Boolean).length;
    step(60);
    assert.equal(
      internals.board.flat().filter(Boolean).length,
      frozen,
      "a paused game must not let the computer move",
    );

    game.resume();
    step(60);
    assert.ok(internals.board.flat().filter(Boolean).length > frozen);
  });

  it("ignores an unknown control name", () => {
    game.start();
    assert.doesNotThrow(() => game.setInput("dpad", true));
  });

  it("stops listening to the window once destroyed", () => {
    const before = listenerCount("keydown");
    assert.ok(before > 0);
    game.destroy();
    assert.equal(listenerCount("keydown"), before - 1);
  });
});
