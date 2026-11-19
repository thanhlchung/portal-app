/**
 * The games this deployment will accept scores for.
 *
 * This is a server-side allowlist, not a client concern: an unknown slug in a
 * request is a 404 rather than a new empty board, so a typo (or a script) cannot
 * create one. It is deliberately allowed to run *ahead* of the client — porting
 * a game then needs no API change — which is why the parity test asserts that
 * every registered client game is in this list, not that the lists are equal.
 *
 * Slugs are the public identity of a game: `/play/<slug>`, `/play/<slug>/scores`
 * and `/api/games/<slug>/scores` all use the same string.
 */
export const GAME_SLUGS = ["asteroids", "space-invaders", "tetris", "connect4"] as const;

export type GameSlug = (typeof GAME_SLUGS)[number];

/** Where `/api/scores` (the pre-multi-game route) points. */
export const DEFAULT_GAME: GameSlug = "asteroids";

export function isGameSlug(value: string): value is GameSlug {
  return (GAME_SLUGS as readonly string[]).includes(value);
}
