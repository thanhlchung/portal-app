/**
 * Headless engine tests.
 *
 * There is no browser on the build machine, so this drives the real simulation
 * against a stub canvas and a virtual clock. It cannot prove anything about
 * how the game *looks*; it does prove the parts that silently produce a broken
 * game rather than an obviously broken one: non-finite positions after wrap,
 * a field that never clears, a run that never ends, input that sticks.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AsteroidsGame } from "./engine";
import type { GameEvents } from "./types";

/* ---------------------------------------------------------------- harness */

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

let now = 0;
let frameCallback: ((time: number) => void) | null = null;
let timers: FakeTimer[] = [];
let nextTimerId = 1;

/** The engine's own types are private by design; tests read them deliberately. */
interface Internals {
  phase: string;
  level: number;
  lives: number;
  score: number;
  width: number;
  height: number;
  ship: { x: number; y: number; vx: number; vy: number; alive: boolean; invuln: number };
  input: Record<string, boolean>;
  asteroids: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: string;
    r: number;
    pts: number;
    rot: number;
    rotSpeed: number;
    verts: { x: number; y: number }[];
  }[];
  bullets: { x: number; y: number }[];
  hitShip: () => void;
}

function internalsOf(game: AsteroidsGame): Internals {
  return game as unknown as Internals;
}

/** Every 2d method is a no-op; every property is settable. */
function fakeContext(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => undefined;
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(width = 390, height = 844): HTMLCanvasElement {
  const context = fakeContext();
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement;
}

const listeners = new Map<string, Set<() => void>>();

function addListener(type: string, handler: () => void): void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)?.add(handler);
}

function removeListener(type: string, handler: () => void): void {
  listeners.get(type)?.delete(handler);
}

function installStubs(): void {
  const fakeWindow = {
    devicePixelRatio: 2,
    addEventListener: addListener,
    removeEventListener: removeListener,
    // Audio is exercised through the real class in a browser only; leaving the
    // constructor absent is exactly the "no Web Audio" path.
    AudioContext: undefined,
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
  };

  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: addListener,
    removeEventListener: removeListener,
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = fakeWindow;
  globals.document = fakeDocument;
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    frameCallback = callback;
    return 1;
  };
  globals.cancelAnimationFrame = () => {
    frameCallback = null;
  };
  globals.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}

/** Advance the virtual clock, fire due timers, then run one animation frame. */
function step(frames = 1, ms = 16): void {
  for (let i = 0; i < frames; i += 1) {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
    for (const timer of due) timer.fn();

    if (!frameCallback) throw new Error("no frame was scheduled");
    const callback = frameCallback;
    frameCallback = null;
    callback(now);
  }
}

function makeGame(events: GameEvents = {}): AsteroidsGame {
  return new AsteroidsGame(fakeCanvas(), events);
}

let game: AsteroidsGame;

beforeEach(() => {
  now = 0;
  frameCallback = null;
  timers = [];
  nextTimerId = 1;
  listeners.clear();
  installStubs();
  game = makeGame();
});

afterEach(() => {
  game.destroy();
});

/* ------------------------------------------------------------------ tests */

describe("asteroids engine", () => {
  it("idles until a run is started", () => {
    assert.equal(game.currentPhase, "idle");
    step(2);
    assert.equal(game.currentPhase, "idle");
  });

  it("starts a run with a full loadout", () => {
    game.start();
    assert.equal(game.currentPhase, "playing");
    assert.deepEqual(game.hud, { score: 0, lives: 3, level: 1 });

    const internals = internalsOf(game);
    // Level 1 spawns four large rocks, well away from the ship.
    assert.equal(internals.asteroids.length, 4);
    assert.equal(internals.asteroids[0]?.size, "large");

    const distanceToShip = Math.hypot(
      (internals.asteroids[0]?.x ?? 0) - internals.ship.x,
      (internals.asteroids[0]?.y ?? 0) - internals.ship.y,
    );
    assert.ok(distanceToShip > 42, "a rock must not spawn on top of the ship");
  });

  it("keeps every position finite and inside the playfield while flying", () => {
    game.start();
    game.setInput("thrust", true);
    game.setInput("left", true);
    game.setInput("fire", true);

    const internals = internalsOf(game);
    for (let frame = 0; frame < 400; frame += 1) {
      step(1);
      if (frame % 25 === 0) {
        // A ship pinned to the middle would pass this test while being frozen.
        assert.ok(Number.isFinite(internals.ship.x), "ship x went non-finite");
        assert.ok(Number.isFinite(internals.ship.y), "ship y went non-finite");
        assert.ok(
          internals.ship.x >= 0 && internals.ship.x < internals.width,
          `ship x escaped the field: ${internals.ship.x}`,
        );
        assert.ok(
          internals.ship.y >= 0 && internals.ship.y < internals.height,
          `ship y escaped the field: ${internals.ship.y}`,
        );
      }
      for (const asteroid of internals.asteroids) {
        assert.ok(Number.isFinite(asteroid.x) && Number.isFinite(asteroid.y));
      }
    }

    // Four bullets in flight is the classic cap.
    assert.ok(internals.bullets.length <= 4, "bullet cap was exceeded");
  });

  it("scores a hit, splits the rock and reports the HUD", () => {
    const hudEvents: number[] = [];
    const scored = makeGame({ onHud: (state) => hudEvents.push(state.score) });
    scored.start();
    scored.setInput("fire", true);

    const internals = internalsOf(scored);
    // Clear the field, then park one large rock on the nose. The ship points
    // up (-y) at spawn, so "ahead" is a smaller y.
    internals.asteroids.length = 0;
    internals.asteroids.push({
      x: internals.ship.x,
      y: internals.ship.y - 60,
      vx: 0,
      vy: 0,
      size: "large",
      r: 42,
      pts: 20,
      rot: 0,
      rotSpeed: 0,
      verts: [],
    });

    step(6);

    assert.ok(internals.score >= 20, `expected a hit to score, got ${internals.score}`);
    assert.ok(hudEvents.includes(20), "the HUD was not told about the new score");
    // A large rock becomes two mediums.
    assert.equal(internals.asteroids.length, 2);
    assert.equal(internals.asteroids[0]?.size, "medium");

    scored.destroy();
  });

  it("advances the level when the field is cleared", () => {
    game.start();
    const internals = internalsOf(game);
    assert.equal(internals.level, 1);

    internals.asteroids.length = 0;
    step(1);

    assert.equal(internals.level, 2);
    // The new wave is bigger than the last one.
    assert.equal(internals.asteroids.length, 5);

    step(1);
    assert.equal(internals.level, 2);
  });

  it("ends the run after the last life and reports the final score", () => {
    const results: { score: number; level: number }[] = [];
    const phases: string[] = [];
    const ended = makeGame({
      onGameOver: (result) => results.push(result),
      onPhaseChange: (phase) => phases.push(phase),
    });
    ended.start();

    const internals = internalsOf(ended);
    internals.lives = 1;
    internals.hitShip();

    // The end is scheduled a beat late so the explosion is visible; nothing
    // should have been reported yet.
    assert.equal(results.length, 0);
    step(20, 16);

    assert.equal(ended.currentPhase, "over");
    assert.deepEqual(phases, ["playing", "over"]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.level, 1);
    assert.equal(typeof results[0]?.score, "number");

    // A finished run must not keep simulating: the ship stays gone.
    const position = internals.ship.x;
    step(10);
    assert.equal(internals.ship.x, position);
    assert.equal(ended.currentPhase, "over");

    ended.destroy();
  });

  it("freezes the simulation while paused and resumes it", () => {
    game.start();
    const internals = internalsOf(game);
    const rock = internals.asteroids[0];
    assert.ok(rock, "a rock to observe");

    // Rocks drift from the first frame (the ship is briefly invulnerable and
    // therefore cannot thrust, which is the original behaviour).
    const start = { x: rock.x, y: rock.y };
    step(2);
    assert.notDeepEqual({ x: rock.x, y: rock.y }, start, "rocks should drift while playing");

    game.pause();
    assert.equal(game.currentPhase, "paused");
    const frozen = { x: rock.x, y: rock.y };
    step(10);
    assert.deepEqual({ x: rock.x, y: rock.y }, frozen, "a paused field must not move");

    game.resume();
    assert.equal(game.currentPhase, "playing");
    step(3);
    assert.notDeepEqual({ x: rock.x, y: rock.y }, frozen, "resuming must resume the simulation");
  });

  it("starts a fresh run from the game-over state", () => {
    game.start();
    const internals = internalsOf(game);
    internals.lives = 1;
    internals.hitShip();
    step(20, 16);
    assert.equal(game.currentPhase, "over");

    game.start();
    assert.equal(game.currentPhase, "playing");
    assert.deepEqual(game.hud, { score: 0, lives: 3, level: 1 });
  });

  it("drops held controls when the game pauses", () => {
    game.start();
    game.setInput("thrust", true);
    game.setInput("fire", true);
    assert.deepEqual(internalsOf(game).input, {
      left: false,
      right: false,
      thrust: true,
      fire: true,
    });

    // Pausing hides the touch controls, so their pointer-up never arrives.
    // Without clearing here the ship would thrust the moment play resumed.
    game.pause();
    assert.deepEqual(internalsOf(game).input, {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    });

    game.resume();
    assert.deepEqual(internalsOf(game).input, {
      left: false,
      right: false,
      thrust: false,
      fire: false,
    });
  });

  it("reports mute changes from the keyboard shortcut path", () => {
    const heard: boolean[] = [];
    const muted = makeGame({ onMutedChange: (value) => heard.push(value) });
    assert.equal(muted.muted, false);

    muted.toggleMute();
    assert.equal(muted.muted, true);
    muted.toggleMute();
    assert.equal(muted.muted, false);
    assert.deepEqual(heard, [true, false]);

    muted.destroy();
  });

  it("stops listening to the window once destroyed", () => {
    const keydownBefore = listeners.get("keydown")?.size ?? 0;
    assert.ok(keydownBefore > 0);
    game.destroy();
    assert.equal(listeners.get("keydown")?.size ?? 0, keydownBefore - 1);
  });
});
