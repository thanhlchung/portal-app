/**
 * Headless tests for the Space Invaders simulation.
 *
 * Same approach as Asteroids: the real engine, driven against a stub canvas on
 * a virtual clock. These assert the things that fail silently — a fleet that
 * walks off screen, a wave that never clears, a run that never ends, a life
 * lost to a bullet that never should have hit.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeCanvas, listenerCount, resetHarness, step } from "../shared/testHarness";
import { GAME_W } from "./constants";
import { SpaceInvadersGame } from "./engine";
import type { GameEvents } from "./types";

interface Internals {
  phase: string;
  score: number;
  lives: number;
  level: number;
  player: { x: number; y: number; w: number; h: number };
  playerAlive: boolean;
  aliens: {
    type: number;
    row: number;
    col: number;
    x: number;
    y: number;
    w: number;
    h: number;
    alive: boolean;
  }[];
  playerBullets: { x: number; y: number; w: number; h: number }[];
  alienBullets: { x: number; y: number }[];
  shields: { x: number; y: number; w: number; h: number; cells: boolean[][] }[];
  input: Record<string, boolean>;
  killDelay: number;
  addScore: (points: number) => void;
  playerHurt: () => void;
}

function internalsOf(game: SpaceInvadersGame): Internals {
  return game as unknown as Internals;
}

function makeGame(events: GameEvents = {}): SpaceInvadersGame {
  return new SpaceInvadersGame(fakeCanvas(), events);
}

/** Alive shield cells — the fleet's shields take damage, so this is a signal. */
function shieldCells(game: SpaceInvadersGame): number {
  return internalsOf(game).shields.reduce(
    (total, shield) => total + shield.cells.flat().filter(Boolean).length,
    0,
  );
}

let game: SpaceInvadersGame;

beforeEach(() => {
  resetHarness();
  game = makeGame();
});

afterEach(() => {
  game.destroy();
});

describe("space invaders engine", () => {
  it("idles until a run is started", () => {
    assert.equal(game.currentPhase, "idle");
    step(2);
    assert.equal(game.currentPhase, "idle");
  });

  it("starts with a full fleet, four shields and three lives", () => {
    game.start();
    assert.equal(game.currentPhase, "playing");

    const internals = internalsOf(game);
    assert.deepEqual(game.hud, { score: 0, lives: 3, level: 1 });
    assert.equal(internals.aliens.length, 55);
    assert.ok(internals.aliens.every((alien) => alien.alive));
    assert.equal(internals.shields.length, 4);
    assert.ok(shieldCells(game) > 0, "shields should start intact");
    // The player sits near the bottom of the 640×720 playfield, centred.
    assert.ok(internals.player.y > 600);
    assert.ok(Math.abs(internals.player.x + internals.player.w / 2 - 320) <= 1);
  });

  it("marches the fleet without letting it leave the playfield", () => {
    game.start();
    const internals = internalsOf(game);
    const startX = internals.aliens[0]!.x;

    step(400);

    // The fleet must have moved...
    assert.notEqual(internals.aliens[0]!.x, startX);
    // ...and stayed inside the board while reversing at the walls.
    for (const alien of internals.aliens) {
      assert.ok(alien.x >= 0, `an invader left the left edge: ${alien.x}`);
      assert.ok(alien.x + alien.w <= GAME_W, `an invader left the right edge: ${alien.x}`);
      assert.ok(Number.isFinite(alien.y));
    }
  });

  it("scores a shot invader and removes it from the fleet", () => {
    game.start();
    const internals = internalsOf(game);

    // Leave exactly one invader, parked above the ship and clear of the shields
    // (the ship starts centred, in the gap between the middle two shields).
    internals.aliens.forEach((alien, index) => {
      alien.alive = index === 20;
    });
    const target = internals.aliens[20]!;
    target.type = 1; // crab: 20 points
    target.x = internals.player.x;
    target.y = internals.player.y - 140;

    game.setInput("fire", true);
    step(30);
    game.setInput("fire", false);

    assert.equal(target.alive, false, "the bullet should have hit the invader");
    assert.ok(internals.score >= 20, `expected a score, got ${internals.score}`);
    assert.equal(internals.score, 20);
  });

  it("ends the run when the last life is lost", () => {
    const results: { score: number; level: number }[] = [];
    const phases: string[] = [];
    const shooting = makeGame({
      onGameOver: (result) => results.push(result),
      onPhaseChange: (phase) => phases.push(phase),
    });
    shooting.start();

    const internals = internalsOf(shooting);
    internals.playerHurt();
    internals.playerHurt();
    assert.equal(shooting.currentPhase, "playing", "two lives left is not a game over");

    internals.playerHurt();
    assert.equal(shooting.currentPhase, "over");
    assert.equal(internals.playerAlive, false);
    assert.deepEqual(phases, ["playing", "over"]);
    assert.deepEqual(results, [{ score: 0, level: 1 }]);

    shooting.destroy();
  });

  it("ends the run when the fleet reaches the ground", () => {
    const results: number[] = [];
    const invaded = makeGame({ onGameOver: (result) => results.push(result.score) });
    invaded.start();

    const internals = internalsOf(invaded);
    const alien = internals.aliens[0]!;
    alien.y = internals.player.y - alien.h + 1;

    step(1);

    assert.equal(invaded.currentPhase, "over");
    assert.equal(results.length, 1);

    invaded.destroy();
  });

  it("advances to the next wave after a cleared fleet", () => {
    game.start();
    const internals = internalsOf(game);
    assert.equal(internals.level, 1);

    // Kill the fleet, then let the level banner elapse.
    internals.aliens.forEach((alien) => {
      alien.alive = false;
    });
    step(100, 16); // ~1.6s, past the 1.2s banner

    assert.equal(internals.level, 2);
    assert.equal(internals.aliens.filter((alien) => alien.alive).length, 55);
    assert.equal(internals.shields.length, 4);
    assert.ok(shieldCells(game) > 0, "shields are rebuilt each wave");
  });

  it("grants an extra life at the score threshold", () => {
    const toasts: string[] = [];
    const scoring = makeGame({ onToast: (message) => toasts.push(message) });
    scoring.start();

    const internals = internalsOf(scoring);
    internals.addScore(5000);

    assert.equal(internals.lives, 4);
    assert.ok(toasts.includes("EXTRA LIFE!"));
    // The award is one-shot per threshold: no second ship for the same 5 000.
    internals.addScore(10);
    assert.equal(internals.lives, 4);

    scoring.destroy();
  });

  it("freezes the fleet while paused and resumes it", () => {
    game.start();
    const internals = internalsOf(game);
    // The fleet only takes a step every ~0.78s, so run long enough for one to
    // happen before freezing — otherwise "unchanged" proves nothing.
    const before = internals.aliens.map((alien) => alien.x);
    step(60);
    const frozen = internals.aliens.map((alien) => alien.x);
    assert.ok(
      frozen.some((x, index) => x !== before[index]),
      "the fleet should have moved before the pause",
    );

    game.pause();
    assert.equal(game.currentPhase, "paused");
    step(40);
    assert.deepEqual(
      internals.aliens.map((alien) => alien.x),
      frozen,
      "a paused fleet must not move",
    );

    game.resume();
    assert.equal(game.currentPhase, "playing");
    step(60);
    assert.notDeepEqual(
      internals.aliens.map((alien) => alien.x),
      frozen,
      "resuming must resume the march",
    );
  });

  it("clears held controls when paused", () => {
    game.start();
    game.setInput("fire", true);
    game.setInput("left", true);
    assert.deepEqual(internalsOf(game).input, { left: true, right: false, fire: true });

    game.pause();
    assert.deepEqual(internalsOf(game).input, { left: false, right: false, fire: false });
  });

  it("ignores an unknown control name", () => {
    game.start();
    assert.doesNotThrow(() => game.setInput("warp", true));
  });

  it("reports mute changes", () => {
    const heard: boolean[] = [];
    const muted = makeGame({ onMutedChange: (value) => heard.push(value) });
    muted.toggleMute();
    muted.toggleMute();
    assert.deepEqual(heard, [true, false]);
    muted.destroy();
  });

  it("stops listening to the window once destroyed", () => {
    const before = listenerCount("keydown");
    assert.ok(before > 0);
    game.destroy();
    assert.equal(listenerCount("keydown"), before - 1);
  });
});
