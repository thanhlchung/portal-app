/**
 * The seam between Pac-Man and the shared shell.
 *
 * Four directions of input, a score HUD with lives, and a score report — the
 * same shape as the other arcade games, which is the point of the shell.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeCanvas, resetHarness, step } from "../shared/testHarness";
import type { ArcadeEngine } from "../shared/types";
import { pacmanDefinition } from "./definition";

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
  engine = pacmanDefinition.createEngine(fakeCanvas(), {});
});

afterEach(() => {
  engine.destroy();
});

describe("pac-man definition", () => {
  it("builds an engine that exposes the whole shell contract", () => {
    for (const call of SHELL_CALLS) {
      assert.equal(
        typeof (engine as unknown as Record<string, unknown>)[call],
        "function",
        `the shell calls ${call}(), and the engine does not implement it`,
      );
    }
  });

  it("declares four directions that reach the engine", () => {
    const names = pacmanDefinition.controls.map((control) => control.name);
    assert.deepEqual([...names].sort(), ["down", "left", "right", "up"]);

    engine.start();
    step(1);
    const internals = engine as unknown as { pac: { nextDir: string | null } };
    for (const control of pacmanDefinition.controls) {
      engine.setInput(control.name, true);
      assert.equal(internals.pac.nextDir, control.name, `control "${control.name}" did nothing`);
    }
  });

  it("reports a score, not an outcome", () => {
    assert.deepEqual(pacmanDefinition.submission({ score: 2300, level: 3 }), {
      kind: "score",
      score: 2300,
      level: 3,
    });
  });

  it("renders its HUD", () => {
    const markup = renderToStaticMarkup(
      <>{pacmanDefinition.renderHud({ score: 2300, level: 3, lives: 2 })}</>,
    );
    assert.ok(markup.includes("2300"));
    assert.ok(markup.includes("LEVEL 3"));
    assert.equal((markup.match(/pac-life/g) ?? []).length, 2, "one life icon per life left");
  });

  it("renders a d-pad and intro instructions", () => {
    const renderControls = pacmanDefinition.renderControls;
    const renderIntro = pacmanDefinition.renderIntro;
    assert.ok(renderControls);
    assert.ok(renderIntro);

    const pad = renderToStaticMarkup(<>{renderControls(() => ({}) as never)}</>);
    assert.equal((pad.match(/<button/g) ?? []).length, 4);
    for (const label of ["Move up", "Move left", "Move down", "Move right"]) {
      assert.ok(pad.includes(`aria-label="${label}"`), `missing button: ${label}`);
    }

    const intro = renderToStaticMarkup(<>{renderIntro({ personalBest: null })}</>);
    assert.ok(/move/i.test(intro));
    assert.ok(/power/i.test(intro));
  });
});
