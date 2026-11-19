import { formatScore } from "../shared/format";
import type { ArcadeDefinition, GameResult } from "../shared/types";
import { AsteroidsGame } from "./engine";
import type { HudState } from "./types";

/**
 * The whole of Asteroids as far as the shared shell is concerned.
 *
 * Note what is *not* here: the canvas, the loop, the overlays, the score panel,
 * mute, pause, the leaderboard links. Those are the shell's, because they are
 * identical for every game. This file is the game.
 */
export const asteroidsDefinition: ArcadeDefinition<HudState, GameResult> = {
  controls: [
    { name: "left", glyph: "\u25E2", label: "ROTATE" },
    { name: "right", glyph: "\u25E3", label: "ROTATE" },
    { name: "thrust", glyph: "\u25B2", label: "THRUST", big: true },
    { name: "fire", glyph: "\u25CF", label: "FIRE", big: true },
  ],

  createEngine: (canvas, events) => new AsteroidsGame(canvas, events),

  renderHud: (hud) => (
    <>
      <span className="play-score">{formatScore(hud.score)}</span>
      <span className="play-level">LEVEL {hud.level}</span>
      <span className="play-lives" aria-label={`${hud.lives} ships left`}>
        {Array.from({ length: Math.min(hud.lives, 8) }, (_, index) => (
          <span className="mini-ship" key={index} aria-hidden="true" />
        ))}
      </span>
    </>
  ),

  renderIntro: () => (
    <dl className="play-keys">
      <div>
        <dt>&#8592; &#8594;</dt>
        <dd>rotate</dd>
      </div>
      <div>
        <dt>&#8593;</dt>
        <dd>thrust</dd>
      </div>
      <div>
        <dt>space</dt>
        <dd>fire</dd>
      </div>
      <div>
        <dt>P / M</dt>
        <dd>pause / mute</dd>
      </div>
    </dl>
  ),

  submission: (result) => ({ kind: "score", score: result.score, level: result.level }),
};
