/**
 * The seam between Space Invaders and the shared shell: the shell's fixed set of
 * calls must land on real engine behaviour, and the HUD/intro must render.
 *
 * The control test is the important one — a control whose `name` does not match
 * an engine input is a button that silently does nothing on a phone.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeCanvas, resetHarness, step } from "../shared/testHarness";
import type { ArcadeEngine } from "../shared/types";
import { spaceInvadersDefinition } from "./definition";

interface EngineInternals {
  input: Record<string, boolean>;
}

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
  engine = spaceInvadersDefinition.createEngine(fakeCanvas(), {});
});

afterEach(() => {
  engine.destroy();
});

describe("space invaders definition", () => {
  it("builds an engine that exposes the whole shell contract", () => {
    for (const call of SHELL_CALLS) {
      assert.equal(
        typeof (engine as unknown as Record<string, unknown>)[call],
        "function",
        `the shell calls ${call}(), and the engine does not implement it`,
      );
    }
  });

  it("declares controls that actually reach an engine input", () => {
    const names = spaceInvadersDefinition.controls.map((control) => control.name);
    // Two directions and a trigger: this game has no thrust.
    assert.deepEqual([...names].sort(), ["fire", "left", "right"]);

    engine.start();
    step(1);
    const { input } = engine as unknown as EngineInternals;
    for (const control of spaceInvadersDefinition.controls) {
      engine.setInput(control.name, true);
      assert.equal(input[control.name], true, `control "${control.name}" toggles no input`);
      engine.setInput(control.name, false);
      assert.equal(input[control.name], false);
    }
  });

  it("maps a finished run onto the two columns the API stores", () => {
    assert.deepEqual(spaceInvadersDefinition.submission({ score: 1230, level: 4 }), {
      score: 1230,
      level: 4,
    });
  });

  it("renders its HUD", () => {
    const markup = renderToStaticMarkup(
      <>{spaceInvadersDefinition.renderHud({ score: 1230, lives: 2, level: 3 })}</>,
    );

    assert.ok(markup.includes("1230"));
    assert.ok(markup.includes("LEVEL 3"));
    assert.equal((markup.match(/mini-ship/g) ?? []).length, 2);
  });

  it("renders intro instructions", () => {
    const render = spaceInvadersDefinition.renderIntro;
    assert.ok(render, "the game should explain its controls");
    const markup = renderToStaticMarkup(<>{render({ personalBest: null })}</>);

    assert.ok(/fire/i.test(markup));
    assert.ok(/move/i.test(markup));
  });
});
