import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthUser } from "../auth.js";
import { getDb, schema } from "../db/index.js";
import { DEFAULT_GAME, GAME_SLUGS, isGameSlug, type GameSlug } from "../games.js";
import type { AppEnv } from "../types.js";

/** How many rows a leaderboard returns. */
export const LEADERBOARD_SIZE = 20;

/**
 * Bounds, not hints. A browser game cannot prove its own score, so these are
 * the limits of what the table will accept: a score large enough to be
 * impossible in the time a run can plausibly last, or a level beyond what a
 * difficulty curve allows, is rejected rather than stored.
 */
export const MAX_SCORE = 1_000_000;
export const MAX_LEVEL = 100;
export const MAX_NAME = 24;

export interface LeaderboardEntry {
  id: string;
  playerName: string;
  score: number;
  level: number;
  /** ISO-8601. Serialised explicitly so the client type is the runtime type. */
  createdAt: string;
  isYou: boolean;
}

export interface YourBest {
  score: number;
  level: number;
  createdAt: string;
  rank: number;
}

/** One launcher card: the game, its best run, and where the caller stands. */
export interface GameSummary {
  slug: GameSlug;
  top: LeaderboardEntry | null;
  you: YourBest | null;
}

export const submitScoreBody = z.object({
  score: z.number().int().min(0).max(MAX_SCORE),
  level: z.number().int().min(1).max(MAX_LEVEL),
  // Optional: the panel offers the account name as a default, but a player may
  // enter initials the way the arcade original did.
  playerName: z.string().trim().min(1).max(MAX_NAME).optional(),
});

const json = <T extends z.ZodType>(schema_: T) =>
  zValidator("json", schema_, (result, c) => {
    if (!result.success) {
      return c.json({ error: "invalid_body", issues: result.error.issues }, 400);
    }
  });

function defaultPlayerName(user: AuthUser): string {
  const name = user.name.trim();
  if (name) return name.slice(0, MAX_NAME);
  const local = user.email.split("@")[0]?.trim();
  return (local || "Player").slice(0, MAX_NAME);
}

type Db = Awaited<ReturnType<typeof getDb>>;

interface ScoreRow {
  id: string;
  userId: string;
  playerName: string;
  score: number;
  level: number;
  createdAt: Date;
}

function toEntry(row: ScoreRow, viewerId: string): LeaderboardEntry {
  return {
    id: row.id,
    playerName: row.playerName,
    score: row.score,
    level: row.level,
    createdAt: row.createdAt.toISOString(),
    isYou: row.userId === viewerId,
  };
}

/**
 * Position of one run on **its game's** board: 1 + the number of runs of that
 * game that beat it. Equal scores are ordered by time (earlier wins), which
 * makes ranks stable and repeatable rather than dependent on row order.
 */
async function rankOf(
  db: Db,
  game: GameSlug,
  row: { score: number; createdAt: Date },
): Promise<number> {
  const [result] = await db
    .select({ better: count() })
    .from(schema.score)
    .where(
      and(
        eq(schema.score.game, game),
        or(
          gt(schema.score.score, row.score),
          and(eq(schema.score.score, row.score), lt(schema.score.createdAt, row.createdAt)),
        ),
      ),
    );
  return (result?.better ?? 0) + 1;
}

/** The top page of one game's board, plus the caller's own best run in it. */
async function readBoard(user: AuthUser, game: GameSlug) {
  const db = await getDb();

  const rows = await db
    .select({
      id: schema.score.id,
      userId: schema.score.userId,
      playerName: schema.score.playerName,
      score: schema.score.score,
      level: schema.score.level,
      createdAt: schema.score.createdAt,
    })
    .from(schema.score)
    .where(eq(schema.score.game, game))
    // Earlier runs win ties, so a new equal score never demotes an old one.
    .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
    .limit(LEADERBOARD_SIZE);

  const [best] = await db
    .select({
      score: schema.score.score,
      level: schema.score.level,
      createdAt: schema.score.createdAt,
    })
    .from(schema.score)
    .where(and(eq(schema.score.game, game), eq(schema.score.userId, user.id)))
    .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
    .limit(1);

  const you: YourBest | null = best
    ? {
        score: best.score,
        level: best.level,
        createdAt: best.createdAt.toISOString(),
        rank: await rankOf(db, game, best),
      }
    : null;

  return {
    game,
    scores: rows.map((row) => toEntry(row, user.id)),
    you,
  };
}

async function writeScore(
  user: AuthUser,
  game: GameSlug,
  input: { score: number; level: number; playerName?: string | undefined },
) {
  const db = await getDb();
  const playerName = input.playerName?.trim() || defaultPlayerName(user);

  const [row] = await db
    .insert(schema.score)
    .values({
      game,
      userId: user.id,
      playerName,
      score: input.score,
      level: input.level,
    })
    .returning();

  if (!row) return null;

  // The rank is computed here, not on the client: the client does not know
  // about runs recorded since it last loaded the board.
  return {
    game,
    score: toEntry(
      {
        id: row.id,
        userId: row.userId,
        playerName: row.playerName,
        score: row.score,
        level: row.level,
        createdAt: row.createdAt,
      },
      user.id,
    ),
    rank: await rankOf(db, game, row),
  };
}

/**
 * Per-game routes, mounted at `/api/games`:
 *
 *   GET  /api/games                    launcher cards (one per game)
 *   GET  /api/games/<slug>/scores      that game's board + your best
 *   POST /api/games/<slug>/scores      save a run, returns its rank
 *
 * The slug is validated against the server's own allowlist so an unknown value
 * is a 404 rather than a brand-new empty board.
 */
export const gamesRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    const db = await getDb();

    // Three indexed queries per game — the whole list is four games today, and
    // the launcher is one page. Worth revisiting (a window function, or a
    // materialised summary) only if the catalogue gets large.
    const summaries: GameSummary[] = [];
    for (const slug of GAME_SLUGS) {
      const [top] = await db
        .select({
          id: schema.score.id,
          userId: schema.score.userId,
          playerName: schema.score.playerName,
          score: schema.score.score,
          level: schema.score.level,
          createdAt: schema.score.createdAt,
        })
        .from(schema.score)
        .where(eq(schema.score.game, slug))
        .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
        .limit(1);

      const [best] = await db
        .select({
          score: schema.score.score,
          level: schema.score.level,
          createdAt: schema.score.createdAt,
        })
        .from(schema.score)
        .where(and(eq(schema.score.game, slug), eq(schema.score.userId, user.id)))
        .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
        .limit(1);

      summaries.push({
        slug,
        top: top ? toEntry(top, user.id) : null,
        you: best
          ? {
              score: best.score,
              level: best.level,
              createdAt: best.createdAt.toISOString(),
              rank: await rankOf(db, slug, best),
            }
          : null,
      });
    }

    return c.json({ games: summaries });
  })

  .get("/:slug/scores", async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);
    return c.json(await readBoard(c.get("user"), slug));
  })

  .post("/:slug/scores", json(submitScoreBody), async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);

    const result = await writeScore(c.get("user"), slug, c.req.valid("json"));
    if (!result) return c.json({ error: "not_saved" }, 500);
    return c.json(result, 201);
  });

/**
 * `/api/scores` is the alias the pre-multi-game client used. It stays working
 * for one reason that has bitten this deployment before: a returning user can
 * still be running a service-worker-cached shell from an earlier build, and it
 * will call this path. It is exactly the default game's board.
 */
export const legacyScoresRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await readBoard(c.get("user"), DEFAULT_GAME)))

  .post("/", json(submitScoreBody), async (c) => {
    const result = await writeScore(c.get("user"), DEFAULT_GAME, c.req.valid("json"));
    if (!result) return c.json({ error: "not_saved" }, 500);
    return c.json(result, 201);
  });

export type GamesRoutes = typeof gamesRoutes;
