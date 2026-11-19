/**
 * The games this deployment knows about, and what kind of result each one
 * produces.
 *
 * This is a server-side allowlist, not a client concern: an unknown slug in a
 * request is a 404 rather than a new empty board, so a typo (or a script) cannot
 * create one. It is deliberately allowed to run *ahead* of the client — porting
 * a game then needs no API change — which is why the parity test asserts that
 * every registered client game is in this list, not that the lists are equal.
 *
 * `kind` is what keeps two different games from sharing one shape of board:
 *
 * - **score** — a run produces a number (Asteroids, Space Invaders, Tetris).
 *   Ranked high to low on `score`, stored one row per run.
 * - **versus** — a match produces a winner (Connect 4). A score would be a lie:
 *   the meaningful record is wins/losses/draws per player, so those live in
 *   their own table and are ranked by wins.
 *
 * Slugs are the public identity of a game: `/play/<slug>`, `/play/<slug>/scores`
 * and `/api/games/<slug>/…` all use the same string.
 */
export const GAMES = {
  asteroids: "score",
  "space-invaders": "score",
  tetris: "score",
  connect4: "versus",
} as const;

export type GameKind = (typeof GAMES)[GameSlug];

export type GameSlug = keyof typeof GAMES;

export const GAME_SLUGS = Object.keys(GAMES) as GameSlug[];

/** Where `/api/scores` (the pre-multi-game route) points. */
export const DEFAULT_GAME: GameSlug = "asteroids";

export function isGameSlug(value: string): value is GameSlug {
  return Object.prototype.hasOwnProperty.call(GAMES, value);
}

export function gameKind(slug: GameSlug): GameKind {
  return GAMES[slug];
}
