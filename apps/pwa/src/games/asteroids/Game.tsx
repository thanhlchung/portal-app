import type { GameProps } from "../registry";
import { ArcadeShell } from "../shared/ArcadeShell";
import { asteroidsDefinition } from "./definition";

/**
 * Asteroids' entry point: the shared shell plus this game's definition. Adding
 * a game means writing one of these (three lines), a definition, and an engine.
 */
export default function Game({ user, game }: GameProps) {
  return <ArcadeShell game={game} user={user} definition={asteroidsDefinition} />;
}
