import { useState } from "react";
import type { ArcadeDefinition } from "../shared/types";
import { DIFFICULTY, type Difficulty } from "./constants";
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

const DIFFICULTY_KEY = "portal.connect4.difficulty";

const LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

const BLURBS: Record<Difficulty, string> = {
  easy: "Slips up now and then",
  medium: "Blocks you, thinks a few moves ahead",
  hard: "Long search — will punish a mistake",
};

/** The player's last choice, so a returning player is not reset to medium. */
function storedDifficulty(): Difficulty {
  try {
    const stored = window.localStorage.getItem(DIFFICULTY_KEY);
    if (stored && Object.prototype.hasOwnProperty.call(DIFFICULTY, stored)) {
      return stored as Difficulty;
    }
  } catch {
    // Private mode, or no storage: medium is a fine default.
  }
  return "medium";
}

function DifficultyPicker({ game }: { game: Connect4Game }) {
  const [value, setValue] = useState<Difficulty>(() => game.difficulty);

  return (
    <div className="difficulty">
      <div className="difficulty-options" role="group" aria-label="Computer difficulty">
        {(Object.keys(DIFFICULTY) as Difficulty[]).map((level) => (
          <button
            key={level}
            className={`difficulty-option ${level === value ? "is-active" : ""}`}
            type="button"
            aria-pressed={level === value}
            onClick={() => {
              game.setDifficulty(level);
              setValue(level);
              try {
                window.localStorage.setItem(DIFFICULTY_KEY, level);
              } catch {
                // Non-fatal: the choice just will not be remembered.
              }
            }}
          >
            {LABELS[level]}
          </button>
        ))}
      </div>
      <p className="difficulty-note">{BLURBS[value]}</p>
    </div>
  );
}

export const connect4Definition: ArcadeDefinition<HudState, VersusResult, Connect4Game> = {
  controls: [],

  createEngine: (canvas, events) => {
    const engine = new Connect4Game(canvas, events);
    // Apply the remembered choice before the first move, so the picker and the
    // engine agree from the start.
    engine.setDifficulty(storedDifficulty());
    return engine;
  },

  renderHud: (hud) => (
    <>
      <span className="play-level">
        {hud.turn === "you" ? "YOUR TURN" : hud.turn === "computer" ? "COMPUTER" : "MATCH OVER"}
      </span>
      <span className="play-level">{hud.difficulty.toUpperCase()}</span>
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

  renderSettings: ({ engine }) => (engine ? <DifficultyPicker game={engine} /> : null),

  submission: (result) => ({ kind: "outcome", outcome: result.outcome }),
};
