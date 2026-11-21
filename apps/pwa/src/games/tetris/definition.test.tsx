/**
 * The seam between Tetris and the shared shell.
 *
 * Two things are specific to this game and can fail silently: six controls that
 * must each reach a real engine input (the shell renders a custom pad here, so
 * a name typo is a dead button), and a tap-action model — rotate and hard drop
 * fire once per press, not continuously while held.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeCanvas, resetHarness, step } from "../shared/testHarness";
import type { ArcadeEngine } from "../shared/types";
import { tetrisDefinition } from "./definition";

interface EngineInternals {
  input: Record<string, boolean>;
  current: { rot: number; type: string } | null;
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
  engine = tetrisDefinition.createEngine(fakeCanvas(), {});
});

afterEach(() => {
  engine.destroy();
});

describe("tetris definition", () => {
  it("builds an engine that exposes the whole shell contract", () => {
    for (const call of SHELL_CALLS) {
      assert.equal(
        typeof (engine as unknown as Record<string, unknown>)[call],
        "function",
        `the shell calls ${call}(), and the engine does not implement it`,
      );
    }
  });

  it("declares controls that reach real engine inputs", () => {
    const names = tetrisDefinition.controls.map((control) => control.name);
    assert.deepEqual(names, ["left", "rotate", "right", "down", "hard", "hold"]);

    engine.start();
    step(1);
    const { input } = engine as unknown as EngineInternals;
    for (const control of tetrisDefinition.controls) {
      engine.setInput(control.name, true);
      assert.equal(input[control.name], true, `control "${control.name}" toggles no input`);
      engine.setInput(control.name, false);
      assert.equal(input[control.name], false);
    }
  });

  it("treats rotate as a tap, not as something held", () => {
    engine.start();
    step(1);
    const internals = engine as unknown as EngineInternals;
    const start = internals.current!;
    // The first piece is randomized, and rotating an O-piece is a deliberate
    // no-op — that is what made this test flap. Assert tap semantics for
    // whichever piece spawned instead of assuming it can rotate.
    const rotates = start.type !== "O";
    const expected = rotates ? (start.rot + 1) % 4 : start.rot;

    engine.setInput("rotate", true);
    step(1);
    assert.equal(internals.current!.rot, expected, "one press rotates once");

    // Holding the button must not keep rotating.
    step(5);
    assert.equal(internals.current!.rot, expected, "a held rotate must not spin");
    engine.setInput("rotate", false);
  });

  it("lays out its own six-button pad", () => {
    const render = tetrisDefinition.renderControls;
    assert.ok(render, "Tetris needs a custom pad");

    const markup = renderToStaticMarkup(
      <>{render(() => ({}) as never)}</>,
    );
    // "pad-button" also appears inside "pad-button--small", so count elements.
    assert.equal((markup.match(/<button/g) ?? []).length, 6);
    for (const label of ["Left", "Right", "Rotate", "Soft drop", "Hard drop", "Hold piece"]) {
      assert.ok(markup.includes(`aria-label="${label}"`), `missing button: ${label}`);
    }
  });

  it("maps a finished run onto the score report the API accepts", () => {
    assert.deepEqual(tetrisDefinition.submission({ score: 4200, level: 5 }), {
      kind: "score",
      score: 4200,
      level: 5,
    });
  });

  it("renders its HUD", () => {
    const markup = renderToStaticMarkup(
      <>{tetrisDefinition.renderHud({ score: 4200, level: 5, lines: 42 })}</>,
    );
    assert.ok(markup.includes("4200"));
    assert.ok(markup.includes("LEVEL 5"));
    assert.ok(markup.includes("LINES 42"));
  });
});
