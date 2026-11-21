import { formatScore } from "../shared/format";
import type { ArcadeDefinition, GameResult } from "../shared/types";
import { PacmanGame } from "./engine";
import type { ControlName, HudState } from "./types";

/**
 * Pac-Man as far as the shell is concerned.
 *
 * The original's touch controls were a 3×2 d-pad in its own chrome; the shell
 * renders a custom pad in the same shape. Swipe-to-steer from the original is
 * gone: the shell only forwards a tap position, and a d-pad is the more precise
 * control in a maze anyway.
 */

const PAD: readonly { name: ControlName; glyph: string; label: string; area: string }[] = [
  { name: "up", glyph: "\u25B2", label: "Move up", area: "pac-up" },
  { name: "left", glyph: "\u25C0", label: "Move left", area: "pac-left" },
  { name: "down", glyph: "\u25BC", label: "Move down", area: "pac-down" },
  { name: "right", glyph: "\u25B6", label: "Move right", area: "pac-right" },
];

export const pacmanDefinition: ArcadeDefinition<HudState, GameResult> = {
  controls: PAD,

  createEngine: (canvas, events) => new PacmanGame(canvas, events),

  renderHud: (hud) => (
    <>
      <span className="play-score">{formatScore(hud.score)}</span>
      <span className="play-level">LEVEL {hud.level}</span>
      <span className="play-lives" aria-label={`${hud.lives} lives left`}>
        {Array.from({ length: Math.min(hud.lives, 5) }, (_, index) => (
          <span className="pac-life" key={index} aria-hidden="true" />
        ))}
      </span>
    </>
  ),

  renderIntro: () => (
    <dl className="play-keys">
      <div>
        <dt>&#9664; &#9650; &#9660; &#9654;</dt>
        <dd>move (or WASD)</dd>
      </div>
      <div>
        <dt>pellets</dt>
        <dd>eat them all to clear the maze</dd>
      </div>
      <div>
        <dt>power</dt>
        <dd>big pellets turn ghosts blue</dd>
      </div>
      <div>
        <dt>chase</dt>
        <dd>200, 400, 800, 1600</dd>
      </div>
    </dl>
  ),

  renderControls: (bind) => (
    <div className="pac-pad">
      {PAD.map((control) => (
        <button
          key={control.name}
          className={`pad-button ${control.area}`}
          type="button"
          aria-label={control.label}
          {...bind(control.name)}
        >
          <span aria-hidden="true">{control.glyph}</span>
        </button>
      ))}
    </div>
  ),

  submission: (result) => ({ kind: "score", score: result.score, level: result.level }),
};
