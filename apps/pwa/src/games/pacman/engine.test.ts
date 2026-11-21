/**
 * Headless tests for Pac-Man.
 *
 * The game runs on a fixed 60 Hz tick, so these drive `tick()` directly rather
 * than through animation frames: deterministic, and fast enough to run a whole
 * death sequence.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeCanvas, listenerCount, resetHarness, step } from "../shared/testHarness";
import { DIRS, FRUIT_POS, PAC_START, T } from "./constants";
import { PacmanGame } from "./engine";
import type { Direction, GameEvents } from "./types";

interface TestGhost {
  x: number;
  y: number;
  dir: Direction;
  state: string;
  fright: boolean;
}

interface Internals {
  phase: string;
  stage: string;
  stageTimer: number;
  score: number;
  level: number;
  lives: number;
  tiles: string[][];
  dotsLeft: number;
  dotsTotal: number;
  frightTimer: number;
  pac: { x: number; y: number; dir: Direction; nextDir: Direction | null; dead: number };
  ghosts: TestGhost[];
  tick(): void;
  eatTile(): void;
  checkCollisions(): void;
  startLevel(newMaze: boolean): void;
  fruit: { active: boolean; spawned: number; timer: number };
}

function internalsOf(game: PacmanGame): Internals {
  return game as unknown as Internals;
}

function makeGame(events: GameEvents = {}): PacmanGame {
  return new PacmanGame(fakeCanvas(), events);
}

/** Advance one 60 Hz tick, whatever the phase gates in the frame loop. */
function ticks(game: PacmanGame, count: number): void {
  const internals = internalsOf(game);
  for (let i = 0; i < count; i += 1) internals.tick();
}

/** Put Pac-Man on the centre of a tile. */
function placePac(game: PacmanGame, col: number, row: number): void {
  const pac = internalsOf(game).pac;
  pac.x = col * T + T / 2;
  pac.y = row * T + T / 2;
}

let game: PacmanGame;

beforeEach(() => {
  resetHarness();
  game = makeGame();
});

afterEach(() => {
  game.destroy();
});

describe("pac-man engine", () => {
  it("idles until a run is started", () => {
    assert.equal(game.currentPhase, "idle");
    step(2);
    assert.equal(game.currentPhase, "idle");
  });

  it("starts with a full maze, three lives and Pac-Man at his corner", () => {
    game.start();
    assert.equal(game.currentPhase, "playing");

    const internals = internalsOf(game);
    assert.deepEqual(game.hud, { score: 0, level: 1, lives: 3 });
    assert.ok(internals.dotsTotal > 200, `expected a full maze of pellets, got ${internals.dotsTotal}`);
    assert.equal(internals.dotsLeft, internals.dotsTotal);
    assert.equal(internals.pac.x, PAC_START.x);
    assert.equal(internals.pac.y, PAC_START.y);
    assert.equal(internals.ghosts.length, 4);
    // READY! first, as the arcade did.
    assert.equal(internals.stage, "ready");
  });

  it("eats pellets and scores for them", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131); // past the READY! beat
    assert.equal(internals.stage, "play");

    game.setInput("left", true);
    ticks(game, 60);

    assert.ok(internals.score > 0, `expected pellets eaten, score was ${internals.score}`);
    assert.ok(internals.dotsLeft < internals.dotsTotal);
  });

  it("turns ghosts blue when a power pellet is eaten", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131);

    // The maze row 23 has a power pellet in column 1.
    internals.tiles[23]![1] = "o";
    placePac(game, 1, 23);
    internals.eatTile();

    assert.equal(internals.score, 50, "a power pellet is worth 50");
    assert.ok(internals.frightTimer > 0, "ghosts should be frightened");
    assert.ok(
      internals.ghosts.some((ghost) => ghost.fright),
      "at least the ghosts outside the pen should be blue",
    );
  });

  it("scores 200 for a frightened ghost and sends it home as eyes", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131);

    const ghost = internals.ghosts[0];
    assert.ok(ghost);
    ghost.fright = true;
    ghost.state = "normal";
    ghost.x = internals.pac.x;
    ghost.y = internals.pac.y;

    internals.checkCollisions();

    assert.equal(internals.score, 200);
    assert.equal(ghost.fright, false);
    assert.equal(ghost.state, "eyes");
  });

  it("loses a life on contact and ends the run after the third", () => {
    const results: { score: number; level: number }[] = [];
    const playable = makeGame({ onGameOver: (result) => results.push(result) });
    playable.start();
    const internals = internalsOf(playable);

    for (let life = 0; life < 3; life += 1) {
      // Force a collision with a live ghost.
      const ghost = internals.ghosts[0];
      assert.ok(ghost);
      ghost.fright = false;
      ghost.state = "normal";
      ghost.x = internals.pac.x;
      ghost.y = internals.pac.y;
      internals.checkCollisions();
      assert.equal(internals.stage, "dead");

      // Run the death animation out.
      for (let i = 0; i < 140 && internals.stage === "dead"; i += 1) internals.tick();
      if (life < 2) {
        assert.equal(internals.lives, 2 - life);
        assert.equal(internals.stage, "ready");
        for (let i = 0; i < 131; i += 1) internals.tick();
      }
    }

    assert.equal(playable.currentPhase, "over");
    assert.equal(internals.lives, 0);
    assert.equal(results.length, 1);
    // The score is whatever was eaten between respawns — the point here is that
    // the run reports its final numbers once, not what those numbers are.
    assert.equal(results[0]?.level, 1);
    assert.equal(typeof results[0]?.score, "number");
    assert.equal(results[0]?.score, internals.score);

    playable.destroy();
  });

  it("clears the level when the last pellet goes, then rebuilds the maze", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131);

    // One pellet left, right under Pac-Man.
    internals.dotsLeft = 1;
    internals.tiles[23]![13] = ".";
    placePac(game, 13, 23);
    internals.eatTile();
    assert.equal(internals.stage, "clear");

    for (let i = 0; i < 151; i += 1) internals.tick();

    assert.equal(internals.level, 2);
    assert.equal(internals.dotsLeft, internals.dotsTotal, "a new maze is laid out");
    assert.equal(internals.stage, "ready");
  });

  it("pauses the whole simulation, not just the drawing", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131);

    game.setInput("left", true);
    step(10, 17);
    const moving = internals.pac.x;

    game.pause();
    assert.equal(game.currentPhase, "paused");
    step(20, 17);
    assert.equal(internals.pac.x, moving, "a paused Pac-Man must not move");

    game.resume();
    step(10, 17);
    assert.notEqual(internals.pac.x, moving);
  });

  it("keeps the fruit timer ticking only while playing", () => {
    game.start();
    const internals = internalsOf(game);
    ticks(game, 131); // past the READY! beat: the fruit only ages during play
    internals.fruit.active = true;
    internals.fruit.timer = 60;
    internals.fruit.spawned = 1;

    game.pause();
    step(10, 17);
    assert.equal(internals.fruit.timer, 60, "the fruit should not expire while paused");

    game.resume();
    step(20, 17);
    assert.ok(internals.fruit.timer < 60);
  });

  it("maps a direction press to the requested turn", () => {
    game.start();
    const internals = internalsOf(game);
    for (const dir of ["up", "left", "down", "right"] as const) {
      game.setInput(dir, true);
      assert.equal(internals.pac.nextDir, dir);
      // Releasing must not clear the request: the turn is consumed at a corner.
      game.setInput(dir, false);
      assert.equal(internals.pac.nextDir, dir);
    }
    // Junk is ignored rather than stored.
    game.setInput("diagonal", true);
    assert.equal(internals.pac.nextDir, "right");
  });

  it("uses the four arcade ghost personalities", () => {
    game.start();
    const internals = internalsOf(game);
    const names = internals.ghosts.map((ghost) => (ghost as unknown as { def: { name: string } }).def.name);
    assert.deepEqual(names, ["blinky", "pinky", "inky", "clyde"]);
    // Blinky starts outside the pen; the others leave on a timer.
    assert.equal(internals.ghosts[0]?.state, "normal");
    assert.equal(internals.ghosts[1]?.state, "home");
  });

  it("stops listening to the window once destroyed", () => {
    const before = listenerCount("keydown");
    game.destroy();
    assert.equal(listenerCount("keydown"), before - 1);
  });

  it("knows its own geometry", () => {
    // A guard on the maze data: every row must be the full width, or the wall
    // painting and collision checks would silently disagree.
    for (const [index, row] of MAP_ROW_LENGTHS.entries()) {
      assert.equal(row, 28, `maze row ${index} is ${row} tiles wide`);
    }
    assert.equal(DIRS.left.x, -1);
    assert.equal(FRUIT_POS.y % T, T / 2);
  });
});

/** Row widths, read from the constants module so the check stays honest. */
import { MAP_SRC } from "./constants";
const MAP_ROW_LENGTHS = MAP_SRC.map((row) => row.length);
