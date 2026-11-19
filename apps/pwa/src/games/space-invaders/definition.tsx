import { formatScore } from "../shared/format";
import type { ArcadeDefinition, GameResult } from "../shared/types";
import { SpaceInvadersGame } from "./engine";
import type { HudState } from "./types";

/**
 * Space Invaders as far as the shared shell is concerned: three controls, a
 * HUD, an intro, and the factory. The canvas, overlays, score panel and
 * leaderboard links all belong to the shell.
 */
export const spaceInvadersDefinition: ArcadeDefinition<HudState, GameResult> = {
  controls: [
    { name: "left", glyph: "\u25C0", label: "LEFT" },
    { name: "right", glyph: "\u25B6", label: "RIGHT" },
    { name: "fire", glyph: "\u25CF", label: "FIRE", big: true },
  ],

  createEngine: (canvas, events) => new SpaceInvadersGame(canvas, events),

  renderHud: (hud) => (
    <>
      <span className="play-score">{formatScore(hud.score)}</span>
      <span className="play-level">LEVEL {hud.level}</span>
      <span className="play-lives" aria-label={`${hud.lives} lives left`}>
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
        <dd>move</dd>
      </div>
      <div>
        <dt>space</dt>
        <dd>fire</dd>
      </div>
      <div>
        <dt>P / M</dt>
        <dd>pause / mute</dd>
      </div>
      <div>
        <dt>UFO</dt>
        <dd>bonus points</dd>
      </div>
    </dl>
  ),

  submission: (result) => ({ kind: "score", score: result.score, level: result.level }),
};
