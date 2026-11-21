/**
 * The slugs of the games this client actually implements.
 *
 * Kept in its own dependency-free module — no React, no CSS, no imports at all —
 * so the API's test suite can import it directly and prove that every game the
 * portal can play has a board the server will accept. That check is the reason
 * this file exists separately from the registry: the registry imports React and
 * therefore cannot be loaded by the server's test runner.
 *
 * Conventions: lowercase, hyphen-separated, stable forever. The slug is the
 * public identity of a game — it appears in `/play/<slug>`, in
 * `/play/<slug>/scores`, and as `score.game` in the database.
 */
export const GAME_SLUGS = ["asteroids", "space-invaders", "tetris", "connect4", "pacman"] as const;

export type GameSlug = (typeof GAME_SLUGS)[number];

/** Where the pre-multi-game `/scores` route and API alias point. */
export const DEFAULT_GAME: GameSlug = "asteroids";

export function isGameSlug(value: string): value is GameSlug {
  return (GAME_SLUGS as readonly string[]).includes(value);
}
