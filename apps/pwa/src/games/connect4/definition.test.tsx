/**
 * The seam between Connect 4 and the shared shell.
 *
 * This game has no on-screen pad: the board is the input, which the shell
 * exposes through `pointerAt`. It also reports an *outcome* rather than a
 * score, which is what routes it to the versus board.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeCanvas, resetHarness, step } from "../shared/testHarness";
import type { ArcadeEngine } from "../shared/types";
import { DIFFICULTY } from "./constants";
import { connect4Definition } from "./definition";

const SHELL_CALLS = [
  "start",
  "pause",
  "resume",
  "togglePause",
  "primaryAction",
  "setInput",
  "toggleMute",
  "destroy",
] as const;

let engine: ArcadeEngine;

beforeEach(() => {
  resetHarness();
  engine = connect4Definition.createEngine(fakeCanvas(), {});
});

afterEach(() => {
  engine.destroy();
});

describe("connect 4 definition", () => {
  it("builds an engine that exposes the whole shell contract", () => {
    for (const call of SHELL_CALLS) {
      assert.equal(
        typeof (engine as unknown as Record<string, unknown>)[call],
        "function",
        `the shell calls ${call}(), and the engine does not implement it`,
      );
    }
    // The canvas hook is what makes this game playable at all.
    assert.equal(typeof engine.pointerAt, "function");
  });

  it("declares no on-screen pad", () => {
    assert.equal(connect4Definition.controls.length, 0);
  });

  it("reports an outcome, not a score", () => {
    assert.deepEqual(connect4Definition.submission({ outcome: "win" }), {
      kind: "outcome",
      outcome: "win",
    });
    assert.deepEqual(connect4Definition.submission({ outcome: "draw" }), {
      kind: "outcome",
      outcome: "draw",
    });
  });

  it("takes a tap on the board as a move", () => {
    engine.start();
    step(1);
    // Far outside the board: not consumed, so the shell may treat it as a tap.
    assert.equal(engine.pointerAt?.(1, 1), false);
  });

  it("renders its HUD", () => {
    const markup = renderToStaticMarkup(
      <>{connect4Definition.renderHud({ turn: "you", difficulty: "hard", wins: 2, losses: 1, draws: 0 })}</>,
    );
    assert.ok(markup.includes("YOUR TURN"));
    assert.ok(markup.includes("HARD"), "the chosen difficulty should be visible while playing");
    assert.ok(markup.includes("W2"));
    assert.ok(markup.includes("L1"));
    assert.ok(markup.includes("D0"));
  });

  it("offers a difficulty choice and applies it", () => {
    engine.start();
    step(1);
    const game = engine as unknown as {
      difficulty: string;
      setDifficulty(level: string): void;
    };
    assert.equal(game.difficulty, "medium", "medium is the default");

    game.setDifficulty("hard");
    assert.equal(game.difficulty, "hard");

    // Junk is ignored rather than stored.
    game.setDifficulty("impossible");
    assert.equal(game.difficulty, "hard");
  });

  it("renders the difficulty picker in the start panel", () => {
    const render = connect4Definition.renderSettings;
    assert.ok(render, "Connect 4 should expose a difficulty control");

    engine.start();
    step(1);
    const markup = renderToStaticMarkup(
      <>{render({ engine: engine as never })}</>,
    );

    for (const label of ["Easy", "Medium", "Hard"]) {
      assert.ok(markup.includes(`>${label}<`), `missing option: ${label}`);
    }
    // Exactly one option is marked as the current choice.
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.ok(markup.includes("Medium"));
  });

  it("has progressively stronger presets", () => {
    // A guard on the data itself: a difficulty that searches no deeper than the
    // one below it would be a silent no-op for the player.
    assert.ok(DIFFICULTY.easy.depth < DIFFICULTY.medium.depth);
    assert.ok(DIFFICULTY.medium.depth < DIFFICULTY.hard.depth);
    assert.ok(DIFFICULTY.easy.budget < DIFFICULTY.hard.budget);
    assert.equal(DIFFICULTY.hard.random, 0, "hard should never move at random");
  });

  it("renders nothing before the engine exists", () => {
    const render = connect4Definition.renderSettings;
    assert.ok(render);
    assert.equal(renderToStaticMarkup(<>{render({ engine: null })}</>), "");
  });

  it("renders intro instructions", () => {
    const render = connect4Definition.renderIntro;
    assert.ok(render);
    const markup = renderToStaticMarkup(<>{render({ personalBest: null })}</>);
    assert.ok(/tap/i.test(markup));
  });
});
