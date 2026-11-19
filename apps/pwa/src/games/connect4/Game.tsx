import type { GameProps } from "../registry";
import { ArcadeShell } from "../shared/ArcadeShell";
import { connect4Definition } from "./definition";

/** Connect 4's entry point: the shared shell plus its definition. */
export default function Game({ user, game }: GameProps) {
  return <ArcadeShell game={game} user={user} definition={connect4Definition} />;
}
