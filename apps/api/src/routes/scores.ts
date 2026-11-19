import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthUser } from "../auth.js";
import { getDb, schema } from "../db/index.js";
import { DEFAULT_GAME, GAME_SLUGS, gameKind, isGameSlug, type GameSlug } from "../games.js";
import type { AppEnv } from "../types.js";

/** How many rows a board returns. */
export const LEADERBOARD_SIZE = 20;

/**
 * Bounds, not hints. A browser game cannot prove its own result, so these are
 * the limits of what the tables will accept: a score large enough to be
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

export type MatchOutcome = "win" | "loss" | "draw";

/** One player's record in a versus game, aggregated over every match. */
export interface VersusRecord {
  playerName: string;
  wins: number;
  losses: number;
  draws: number;
  played: number;
  rank: number;
  isYou: boolean;
}

/** A launcher card. The shape follows the game's kind, so a card cannot be read wrong. */
export type GameSummary =
  | { slug: GameSlug; kind: "score"; top: LeaderboardEntry | null; you: YourBest | null }
  | { slug: GameSlug; kind: "versus"; top: VersusRecord | null; you: VersusRecord | null };

export const submitScoreBody = z.object({
  score: z.number().int().min(0).max(MAX_SCORE),
  level: z.number().int().min(1).max(MAX_LEVEL),
  // Optional: the panel offers the account name as a default, but a player may
  // enter initials the way the arcade original did.
  playerName: z.string().trim().min(1).max(MAX_NAME).optional(),
});

export const submitMatchBody = z.object({
  outcome: z.enum(["win", "loss", "draw"]),
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
    kind: "score" as const,
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
    kind: "score" as const,
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
 * Wins first, then draws, then fewest losses, then name — so a record is
 * orderable and a tie never depends on row order.
 */
function compareRecords(
  a: { playerName: string; wins: number; losses: number; draws: number },
  b: { playerName: string; wins: number; losses: number; draws: number },
): number {
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (b.draws !== a.draws) return b.draws - a.draws;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.playerName.localeCompare(b.playerName);
}

interface AggregateRow {
  userId: string;
  playerName: string;
  wins: number;
  losses: number;
  draws: number;
}

function toRecord(row: AggregateRow & { rank: number }, viewerId: string): VersusRecord {
  return {
    playerName: row.playerName,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    played: row.wins + row.losses + row.draws,
    rank: row.rank,
    isYou: row.userId === viewerId,
  };
}

/**
 * Every player's record in a versus game, ordered.
 *
 * The aggregation happens in SQL and the ordering in memory: the result is one
 * row per player who has ever finished a match, which is a small set by
 * construction. Ordering in SQL would need a window function to rank tie-broken
 * records, and that is more machinery than this board earns today.
 */
async function readRecords(user: AuthUser, game: GameSlug) {
  const db = await getDb();

  const rows = await db
    .select({
      userId: schema.gameMatch.userId,
      playerName: sql<string>`max(${schema.gameMatch.playerName})`,
      wins: sql<number>`(count(*) filter (where ${schema.gameMatch.outcome} = 'win'))::int`,
      losses: sql<number>`(count(*) filter (where ${schema.gameMatch.outcome} = 'loss'))::int`,
      draws: sql<number>`(count(*) filter (where ${schema.gameMatch.outcome} = 'draw'))::int`,
    })
    .from(schema.gameMatch)
    .where(eq(schema.gameMatch.game, game))
    .groupBy(schema.gameMatch.userId);

  const ordered = rows
    .map((row) => ({
      userId: row.userId,
      playerName: row.playerName,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
    }))
    .sort(compareRecords)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const mine = ordered.find((row) => row.userId === user.id);
  const you: VersusRecord | null = mine ? toRecord(mine, user.id) : null;

  return {
    game,
    kind: "versus" as const,
    records: ordered.slice(0, LEADERBOARD_SIZE).map((row) => toRecord(row, user.id)),
    you,
  };
}

async function writeMatch(
  user: AuthUser,
  game: GameSlug,
  input: { outcome: MatchOutcome; playerName?: string | undefined },
) {
  const db = await getDb();
  const playerName = input.playerName?.trim() || defaultPlayerName(user);

  const [row] = await db
    .insert(schema.gameMatch)
    .values({ game, userId: user.id, playerName, outcome: input.outcome })
    .returning();

  if (!row) return null;

  // Re-read rather than computing the record here: the aggregate is the truth,
  // and it makes the response identical to what the board will show.
  const board = await readRecords(user, game);
  return { game, kind: "versus" as const, record: board.you, rank: board.you?.rank ?? null };
}

/**
 * Per-game routes, mounted at `/api/games`:
 *
 *   GET  /api/games                    launcher cards (one per game)
 *   GET  /api/games/<slug>/scores      that game's board + your best   (score games)
 *   POST /api/games/<slug>/scores      save a run, returns its rank    (score games)
 *   GET  /api/games/<slug>/matches     records board + your record     (versus games)
 *   POST /api/games/<slug>/matches     record a match, returns your rank (versus games)
 *
 * The slug is validated against the server's own allowlist so an unknown value
 * is a 404 rather than a brand-new empty board, and a route is refused when it
 * does not match the game's kind — a Connect 4 score would be meaningless.
 */
export const gamesRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    const summaries: GameSummary[] = [];

    for (const slug of GAME_SLUGS) {
      if (gameKind(slug) === "versus") {
        const board = await readRecords(user, slug);
        summaries.push({
          slug,
          kind: "versus",
          top: board.records[0] ?? null,
          you: board.you,
        });
        continue;
      }

      const board = await readBoard(user, slug);
      summaries.push({
        slug,
        kind: "score",
        top: board.scores[0] ?? null,
        you: board.you,
      });
    }

    return c.json({ games: summaries });
  })

  .get("/:slug/scores", async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);
    if (gameKind(slug) !== "score") return c.json({ error: "wrong_game_kind" }, 400);
    return c.json(await readBoard(c.get("user"), slug));
  })

  .post("/:slug/scores", json(submitScoreBody), async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);
    if (gameKind(slug) !== "score") return c.json({ error: "wrong_game_kind" }, 400);

    const result = await writeScore(c.get("user"), slug, c.req.valid("json"));
    if (!result) return c.json({ error: "not_saved" }, 500);
    return c.json(result, 201);
  })

  .get("/:slug/matches", async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);
    if (gameKind(slug) !== "versus") return c.json({ error: "wrong_game_kind" }, 400);
    return c.json(await readRecords(c.get("user"), slug));
  })

  .post("/:slug/matches", json(submitMatchBody), async (c) => {
    const slug = c.req.param("slug");
    if (!isGameSlug(slug)) return c.json({ error: "unknown_game" }, 404);
    if (gameKind(slug) !== "versus") return c.json({ error: "wrong_game_kind" }, 400);

    const result = await writeMatch(c.get("user"), slug, c.req.valid("json"));
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
