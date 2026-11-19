import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { DEFAULT_GAME, GAME_SLUGS, isGameSlug, type GameSlug } from "./slugs";

/**
 * The one list of games: the router, the launcher and the score screens all
 * read from here, so adding a game is a one-entry change plus its modules.
 *
 * Each game is loaded with `React.lazy`, which is the point of the registry
 * existing at all: without it every engine would be bundled into the shell that
 * a notes-only visitor downloads. Vite emits one chunk per `import()` below, so
 * opening Tetris never downloads the Asteroids engine — and the service worker's
 * asset cache keeps a game playable offline once it has been opened.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** What a game module may rely on. Kept deliberately small. */
export interface GameProps {
  user: SessionUser;
  game: GameMeta;
}

export interface GameMeta {
  /** URL segment and database key. Must be in `GAME_SLUGS`. */
  slug: GameSlug;
  title: string;
  /** One line for the launcher card. */
  blurb: string;
  /** Short control hint, so a card can describe the game without the game. */
  controls: string;
  Component: LazyExoticComponent<ComponentType<GameProps>>;
}

export const games: readonly GameMeta[] = [
  {
    slug: "asteroids",
    title: "Asteroids",
    blurb: "Rotate, thrust and shoot the rocks before they shoot you.",
    controls: "Arrow keys or the on-screen buttons",
    Component: lazy(() => import("./asteroids/Game")),
  },
  {
    slug: "space-invaders",
    title: "Space Invaders",
    blurb: "Clear the marching fleet before it reaches the ground — and shoot the UFO for bonus points.",
    controls: "Arrow keys or the on-screen buttons",
    Component: lazy(() => import("./space-invaders/Game")),
  },
];

export function findGame(slug: string | undefined): GameMeta | undefined {
  if (!slug) return undefined;
  return games.find((game) => game.slug === slug);
}

export { DEFAULT_GAME, GAME_SLUGS, isGameSlug, type GameSlug };
