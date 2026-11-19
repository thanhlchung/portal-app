import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, schema } from "../db/index.js";
import type { AuthUser } from "../auth.js";
import type { AppEnv } from "../types.js";

/** How many rows the leaderboard returns. */
export const LEADERBOARD_SIZE = 20;

/**
 * Bounds, not hints. A browser game cannot prove its own score, so these are
 * the limits of what the table will accept: a score large enough to be
 * impossible in the time a run can plausibly last, or a level beyond what the
 * difficulty curve allows, is rejected rather than stored.
 *
 * Chosen from the game's own constants: 10 000 points buys an extra ship, and
 * a level takes minutes, so a million points is already implausible.
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

/**
 * Position of one run on the leaderboard: 1 + the number of runs that beat it.
 *
 * Equal scores are ordered by time (earlier wins), which makes ranks stable and
 * repeatable rather than dependent on row order. `score.ranking_idx` covers the
 * range comparison.
 */
async function rankOf(db: Db, row: { score: number; createdAt: Date }): Promise<number> {
  const [result] = await db
    .select({ better: count() })
    .from(schema.score)
    .where(
      or(
        gt(schema.score.score, row.score),
        and(eq(schema.score.score, row.score), lt(schema.score.createdAt, row.createdAt)),
      ),
    );
  return (result?.better ?? 0) + 1;
}

export const scoresRoutes = new Hono<AppEnv>()
  /**
   * The leaderboard plus the caller's own best run.
   *
   * Both in one response because the page shows both, and two round trips on a
   * cold mobile connection is a worse experience than one slightly larger body.
   */
  .get("/", async (c) => {
    const user = c.get("user");
    const db = await getDb();

    const rows = await db
      .select({
        id: schema.score.id,
        playerName: schema.score.playerName,
        score: schema.score.score,
        level: schema.score.level,
        createdAt: schema.score.createdAt,
        userId: schema.score.userId,
      })
      .from(schema.score)
      // Earlier runs win ties, so a new equal score never demotes an old one.
      .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
      .limit(LEADERBOARD_SIZE);

    const scores: LeaderboardEntry[] = rows.map((row) => ({
      id: row.id,
      playerName: row.playerName,
      score: row.score,
      level: row.level,
      createdAt: row.createdAt.toISOString(),
      isYou: row.userId === user.id,
    }));

    const [best] = await db
      .select({
        score: schema.score.score,
        level: schema.score.level,
        createdAt: schema.score.createdAt,
      })
      .from(schema.score)
      .where(eq(schema.score.userId, user.id))
      .orderBy(desc(schema.score.score), asc(schema.score.createdAt))
      .limit(1);

    const you: YourBest | null = best
      ? {
          score: best.score,
          level: best.level,
          createdAt: best.createdAt.toISOString(),
          rank: await rankOf(db, best),
        }
      : null;

    return c.json({ scores, you });
  })

  .post("/", json(submitScoreBody), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const playerName = input.playerName?.trim() || defaultPlayerName(user);

    const db = await getDb();
    const [row] = await db
      .insert(schema.score)
      .values({
        userId: user.id,
        playerName,
        score: input.score,
        level: input.level,
      })
      .returning();

    if (!row) {
      return c.json({ error: "not_saved" }, 500);
    }

    const entry: LeaderboardEntry = {
      id: row.id,
      playerName: row.playerName,
      score: row.score,
      level: row.level,
      createdAt: row.createdAt.toISOString(),
      isYou: true,
    };

    // The rank is computed here, not on the client: the client does not know
    // about runs recorded since it last loaded the board.
    return c.json({ score: entry, rank: await rankOf(db, row) }, 201);
  });

export type ScoresRoutes = typeof scoresRoutes;
