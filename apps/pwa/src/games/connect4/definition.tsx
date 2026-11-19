import type { ArcadeDefinition } from "../shared/types";
import { Connect4Game } from "./engine";
import type { HudState, VersusResult } from "./types";

/**
 * Connect 4 as far as the shell is concerned.
 *
 * No `controls`: the board itself is the input, so there is no on-screen pad —
 * the shell hands taps to `pointerAt` and the game picks the column under the
 * finger. The result is an outcome, which is what makes this game use the
 * versus board rather than a score board.
 */
export const connect4Definition: ArcadeDefinition<HudState, VersusResult> = {
  controls: [],

  createEngine: (canvas, events) => new Connect4Game(canvas, events),

  renderHud: (hud) => (
    <>
      <span className="play-level">
        {hud.turn === "you" ? "YOUR TURN" : hud.turn === "computer" ? "COMPUTER" : "MATCH OVER"}
      </span>
      <span className="play-score">
        W{hud.wins} · L{hud.losses} · D{hud.draws}
      </span>
    </>
  ),

  renderIntro: () => (
    <dl className="play-keys">
      <div>
        <dt>tap</dt>
        <dd>drop a disc in that column</dd>
      </div>
      <div>
        <dt>1–7</dt>
        <dd>same, from a keyboard</dd>
      </div>
      <div>
        <dt>P / M</dt>
        <dd>pause / mute</dd>
      </div>
      <div>
        <dt>four</dt>
        <dd>in a row wins</dd>
      </div>
    </dl>
  ),

  submission: (result) => ({ kind: "outcome", outcome: result.outcome }),
};
