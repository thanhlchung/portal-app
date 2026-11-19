/**
 * The seam between a game and the shared shell.
 *
 * The shell drives an engine through a fixed set of calls and renders whatever
 * the definition hands it. Both directions can fail silently: a control whose
 * `name` does not match an engine input is a button that does nothing, and a
 * HUD renderer that throws or formats wrongly is only visible in a browser.
 * So this exercises the real definition against the real engine, and renders
 * the HUD to static markup.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeCanvas, resetHarness, step } from "../shared/testHarness";
import type { ArcadeEngine } from "../shared/types";
import { asteroidsDefinition } from "./definition";

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
  engine = asteroidsDefinition.createEngine(fakeCanvas(), {});
});

afterEach(() => {
  engine.destroy();
});

describe("asteroids definition", () => {
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
    assert.ok(asteroidsDefinition.controls.length > 0, "the game should expose touch controls");
    engine.start();
    step(1);

    const { input } = engine as unknown as EngineInternals;
    for (const control of asteroidsDefinition.controls) {
      engine.setInput(control.name, true);
      assert.equal(
        input[control.name],
        true,
        `control "${control.name}" is labelled "${control.label}" but toggles no engine input`,
      );
      engine.setInput(control.name, false);
      assert.equal(input[control.name], false);
    }
  });

  it("ignores a control name it does not recognise", () => {
    engine.start();
    step(1);
    // A stale definition must not throw inside a pointer handler.
    assert.doesNotThrow(() => engine.setInput("not-a-control", true));
  });

  it("reports phase changes the shell can render overlays from", () => {
    const phases: string[] = [];
    const driven = asteroidsDefinition.createEngine(fakeCanvas(), {
      onPhaseChange: (phase) => phases.push(phase),
    });

    driven.start();
    step(1);
    driven.pause();
    driven.resume();
    driven.destroy();

    assert.deepEqual(phases, ["playing", "paused", "playing"]);
  });

  it("maps a finished run onto the score report the API accepts", () => {
    assert.deepEqual(asteroidsDefinition.submission({ score: 4210, level: 6 }), {
      kind: "score",
      score: 4210,
      level: 6,
    });
  });

  it("renders its HUD", () => {
    const markup = renderToStaticMarkup(
      <>{asteroidsDefinition.renderHud({ score: 7, lives: 2, level: 3 })}</>,
    );

    assert.ok(markup.includes("0007"), "the score is not zero-padded like an arcade marquee");
    assert.ok(markup.includes("LEVEL 3"));
    // Two ships left, drawn as CSS triangles — one span each.
    assert.equal((markup.match(/mini-ship/g) ?? []).length, 2);
  });

  it("renders intro instructions", () => {
    const render = asteroidsDefinition.renderIntro;
    assert.ok(render, "Asteroids should explain its controls");
    const markup = renderToStaticMarkup(<>{render({ personalBest: null })}</>);

    assert.ok(/rotate/i.test(markup));
    assert.ok(/fire/i.test(markup));
    assert.ok(/thrust/i.test(markup));
  });
});
