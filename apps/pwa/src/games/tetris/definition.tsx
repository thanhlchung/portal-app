import { formatScore } from "../shared/format";
import type { ArcadeDefinition, ControlSpec, GameResult } from "../shared/types";
import { TetrisGame } from "./engine";
import type { HudState } from "./types";

/**
 * The on-screen pad. Tetris needs six controls, which do not fit one row, so it
 * lays out its own 2×3 grid — the shell still supplies the wiring (`bind`), the
 * pause/mute buttons and the overlays.
 */
const PAD: readonly (ControlSpec & { small?: boolean })[] = [
  { name: "left", glyph: "\u25C0", label: "Left" },
  { name: "rotate", glyph: "\u27F3", label: "Rotate" },
  { name: "right", glyph: "\u25B6", label: "Right" },
  { name: "down", glyph: "\u25BC", label: "Soft drop" },
  { name: "hard", glyph: "\u2913", label: "Hard drop" },
  { name: "hold", glyph: "HOLD", label: "Hold piece", small: true },
];

export const tetrisDefinition: ArcadeDefinition<HudState, GameResult> = {
  controls: PAD,

  createEngine: (canvas, events) => new TetrisGame(canvas, events),

  renderHud: (hud) => (
    <>
      <span className="play-score">{formatScore(hud.score)}</span>
      <span className="play-level">LEVEL {hud.level}</span>
      <span className="play-level">LINES {hud.lines}</span>
    </>
  ),

  renderIntro: () => (
    <dl className="play-keys">
      <div>
        <dt>&#9664; &#9654;</dt>
        <dd>move</dd>
      </div>
      <div>
        <dt>&#9650; / Z</dt>
        <dd>rotate</dd>
      </div>
      <div>
        <dt>space</dt>
        <dd>hard drop</dd>
      </div>
      <div>
        <dt>C / shift</dt>
        <dd>hold</dd>
      </div>
    </dl>
  ),

  renderControls: (bind) => (
    <div className="tetris-pad">
      {PAD.map((control) => (
        <button
          key={control.name}
          className={`pad-button ${control.small ? "pad-button--small" : ""}`}
          type="button"
          aria-label={control.label}
          {...bind(control.name)}
        >
          <span aria-hidden="true">{control.glyph}</span>
        </button>
      ))}
    </div>
  ),

  submission: (result) => ({ score: result.score, level: result.level }),
};
