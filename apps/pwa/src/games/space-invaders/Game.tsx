import type { GameProps } from "../registry";
import { ArcadeShell } from "../shared/ArcadeShell";
import { spaceInvadersDefinition } from "./definition";

/** Space Invaders' entry point: the shared shell plus its definition. */
export default function Game({ user, game }: GameProps) {
  return <ArcadeShell game={game} user={user} definition={spaceInvadersDefinition} />;
}
