import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
} from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, schema } from "../db/index.js";
import { rateLimit, throttle } from "../limits.js";
import type { AppEnv } from "../types.js";

/* ------------------------------------------------------------------ */
/* Contract                                                           */
/* ------------------------------------------------------------------ */

export type ShareRole = "owner" | "guest";
export type ShareStatus = "active" | "ended";

export interface ShareEventView {
  id: string;
  kind: string;
  actorName: string | null;
  createdAt: string;
}

export interface ShareSummary {
  id: string;
  role: ShareRole;
  status: ShareStatus;
  durationMinutes: number | null;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  participantCount: number;
  /** Server clock. Clients compute ages against this, never their own clock. */
  serverTime: string;
  /** Owner only. */
  events?: ShareEventView[];
}

export interface ParticipantView {
  userId: string;
  displayName: string;
  role: ShareRole;
  sharing: boolean;
  lastAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  isYou: boolean;
}

export interface PositionsPayload {
  share: ShareSummary;
  participants: ParticipantView[];
}

export interface InviteView {
  id: string;
  token: string;
  /** Relative path; the client makes it absolute against its own origin. */
  url: string;
  expiresAt: string;
}

export interface RecentPersonView {
  userId: string;
  displayName: string;
  lastSharedAt: string;
}

/* ------------------------------------------------------------------ */
/* Limits and timings                                                 */
/* ------------------------------------------------------------------ */

/** Presets offered by the UI. "Until I stop" is the null case. */
export const DURATION_PRESETS = [15, 30, 60, 120] as const;
/** The hard cap for an open-ended share; privacy by construction. */
export const MAX_OPEN_MINUTES = 8 * 60;
export const MAX_PARTICIPANTS = 10;
export const MAX_INVITES_PER_SHARE = MAX_PARTICIPANTS - 1;
export const MAX_ACTIVE_SHARES = 3;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export const PING_MIN_INTERVAL_MS = 5_000;
export const POSITION_READ_MIN_INTERVAL_MS = 1_000;
export const CREATE_LIMIT_PER_HOUR = 10;
export const CREATE_WINDOW_MS = 60 * 60 * 1000;
export const JOIN_ATTEMPT_LIMIT = 10;
export const JOIN_ATTEMPT_WINDOW_MS = 60 * 1000;

export const MAX_ACCURACY_METRES = 100_000;
const COORD_SCALE = 1_000_000; // six decimal places, ~11 cm

const SWEEP_MIN_INTERVAL_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Request bodies                                                     */
/* ------------------------------------------------------------------ */

export const createShareBody = z.object({
  /** null = "until I stop", capped at MAX_OPEN_MINUTES. */
  durationMinutes: z
    .union([z.literal(15), z.literal(30), z.literal(60), z.literal(120), z.null()])
    .default(null),
  /** One single-use link per intended recipient (the UI pairs them 1:1). */
  inviteCount: z.number().int().min(1).max(MAX_INVITES_PER_SHARE).default(1),
});

export const pingBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(MAX_ACCURACY_METRES),
});

export const sharingBody = z.object({ sharing: z.boolean() });

export const joinBody = z.object({ token: z.string().trim().min(16).max(200) });

const tokenQuery = z.object({ token: z.string().trim().min(16).max(200) });

const idParam = z.object({ id: z.uuid("Not a valid id") });

const participantParam = z.object({
  id: z.uuid("Not a valid id"),
  userId: z.string().min(1).max(120),
});

const json = <T extends z.ZodType>(zodSchema: T) =>
  zValidator("json", zodSchema, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_body" }, 400);
  });

const query = <T extends z.ZodType>(zodSchema: T) =>
  zValidator("query", zodSchema, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_body" }, 400);
  });

const param = <T extends z.ZodType>(zodSchema: T) =>
  zValidator("param", zodSchema, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_id" }, 400);
  });

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

type Db = Awaited<ReturnType<typeof getDb>>;
/** The transaction handle Drizzle hands to `db.transaction` callbacks. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ShareRow = typeof schema.share.$inferSelect;
type ParticipantRow = typeof schema.shareParticipant.$inferSelect;

function fail(c: Context<AppEnv>, status: ContentfulStatusCode, code: string) {
  return c.json({ error: code }, status);
}

function rateLimited(c: Context<AppEnv>, retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  c.header("Retry-After", String(seconds));
  return c.json({ error: "rate_limited", retryAfterSeconds: seconds }, 429);
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Display names only. An email address must never appear in a share payload. */
function displayNameFor(user: { name?: string | null; email?: string | null }): string {
  const name = (user.name ?? "").trim();
  if (name) return name.slice(0, 32);
  const local = (user.email ?? "").split("@")[0]?.trim();
  return (local || "Guest").slice(0, 32);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function isActive(share: ShareRow, now: Date): boolean {
  return share.status === "active" && share.expiresAt.getTime() > now.getTime();
}

/**
 * Expiry is derived from `expiresAt`, not from `status`: an unswept row can
 * never serve coordinates just because no request has rewritten it yet.
 */
function effectiveState(
  share: ShareRow,
  now: Date,
): { status: ShareStatus; endedAt: Date | null; endReason: string | null } {
  if (share.status === "ended") {
    return { status: "ended", endedAt: share.endedAt ?? now, endReason: share.endReason ?? "manual" };
  }
  if (share.expiresAt.getTime() <= now.getTime()) {
    return { status: "ended", endedAt: share.expiresAt, endReason: "expired" };
  }
  return { status: "active", endedAt: null, endReason: null };
}

function summaryOf(
  share: ShareRow,
  viewerRole: string,
  now: Date,
  participantCount: number,
  events?: ShareEventView[],
): ShareSummary {
  const state = effectiveState(share, now);
  const summary: ShareSummary = {
    id: share.id,
    role: viewerRole === "owner" ? "owner" : "guest",
    status: state.status,
    durationMinutes: share.durationMinutes,
    expiresAt: share.expiresAt.toISOString(),
    endedAt: iso(state.endedAt),
    endReason: state.endReason,
    createdAt: share.createdAt.toISOString(),
    participantCount,
    serverTime: now.toISOString(),
  };
  if (events) summary.events = events;
  return summary;
}

async function loadMembership(
  db: Db,
  shareId: string,
  userId: string,
): Promise<{ share: ShareRow; participant: ParticipantRow } | null> {
  const [row] = await db
    .select({ share: schema.share, participant: schema.shareParticipant })
    .from(schema.shareParticipant)
    .innerJoin(schema.share, eq(schema.share.id, schema.shareParticipant.shareId))
    .where(
      and(
        eq(schema.shareParticipant.shareId, shareId),
        eq(schema.shareParticipant.userId, userId),
        eq(schema.shareParticipant.state, "joined"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function joinedCount(db: Db, shareId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.shareParticipant)
    .where(
      and(eq(schema.shareParticipant.shareId, shareId), eq(schema.shareParticipant.state, "joined")),
    );
  return Number(row?.n ?? 0);
}

async function eventsFor(db: Db, shareId: string): Promise<ShareEventView[]> {
  const rows = await db
    .select({
      event: schema.shareEvent,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.shareEvent)
    .leftJoin(schema.user, eq(schema.user.id, schema.shareEvent.actorId))
    .where(eq(schema.shareEvent.shareId, shareId))
    .orderBy(asc(schema.shareEvent.createdAt))
    .limit(100);
  return rows.map(({ event, name, email }) => ({
    id: event.id,
    kind: event.kind,
    actorName: name === null && email === null ? null : displayNameFor({ name, email }),
    createdAt: event.createdAt.toISOString(),
  }));
}

async function participantsFor(
  db: Db,
  shareId: string,
  viewerId: string,
): Promise<ParticipantView[]> {
  const rows = await db
    .select({
      participant: schema.shareParticipant,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.shareParticipant)
    .innerJoin(schema.user, eq(schema.user.id, schema.shareParticipant.userId))
    .where(
      and(eq(schema.shareParticipant.shareId, shareId), eq(schema.shareParticipant.state, "joined")),
    )
    .orderBy(asc(schema.shareParticipant.joinedAt));

  return rows.map(({ participant, name, email }) => ({
    userId: participant.userId,
    displayName: displayNameFor({ name, email }),
    role: participant.role === "owner" ? "owner" : "guest",
    sharing: participant.sharing,
    // Coordinates exist only while the participant is publishing (FR-16).
    lastAt: participant.sharing ? iso(participant.lastAt) : null,
    lat: participant.sharing ? participant.lastLat : null,
    lng: participant.sharing ? participant.lastLng : null,
    accuracy: participant.sharing ? participant.lastAccuracy : null,
    isYou: participant.userId === viewerId,
  }));
}

async function positionsPayload(
  db: Db,
  share: ShareRow,
  viewer: ParticipantRow,
  now: Date,
): Promise<PositionsPayload> {
  const participants = await participantsFor(db, share.id, viewer.userId);
  return {
    share: summaryOf(share, viewer.role, now, participants.length),
    participants,
  };
}

async function createInvite(
  db: Tx,
  share: ShareRow,
  createdBy: string,
  now: Date,
): Promise<InviteView> {
  const token = newToken();
  const expiresAt = new Date(
    Math.min(now.getTime() + INVITE_TTL_MS, share.expiresAt.getTime()),
  );
  const [row] = await db
    .insert(schema.shareInvite)
    .values({
      shareId: share.id,
      createdBy,
      tokenHash: hashToken(token),
      expiresAt,
    })
    .returning();
  return {
    id: row!.id,
    token,
    url: `/join/${token}`,
    expiresAt: row!.expiresAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Lazy expiry and retention sweep                                    */
/* ------------------------------------------------------------------ */

let lastSweepAt = 0;

/** Test seam: force the next request to sweep, regardless of the throttle. */
export function resetSweepState(): void {
  lastSweepAt = 0;
}

/**
 * Mark expired shares ended (clearing their coordinates) and delete shares
 * that ended more than 24 hours ago. No cron: this runs opportunistically, at
 * most once a minute, from the first share request that arrives.
 */
export async function sweepEndedShares(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  await db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: schema.share.id })
      .from(schema.share)
      .where(and(eq(schema.share.status, "active"), lte(schema.share.expiresAt, now)));

    if (expired.length > 0) {
      const ids = expired.map((row) => row.id);
      await tx
        .update(schema.shareParticipant)
        .set({
          sharing: false,
          lastLat: null,
          lastLng: null,
          lastAccuracy: null,
          lastAt: null,
          updatedAt: now,
        })
        .where(inArray(schema.shareParticipant.shareId, ids));
      await tx
        .update(schema.share)
        .set({ status: "ended", endedAt: now, endReason: "expired", updatedAt: now })
        .where(inArray(schema.share.id, ids));
      await tx.insert(schema.shareEvent).values(
        ids.map((shareId) => ({ shareId, actorId: null, kind: "expired" })),
      );
    }

    await tx
      .delete(schema.share)
      .where(and(eq(schema.share.status, "ended"), lte(schema.share.endedAt, cutoff)));
  });
}

async function maybeSweep(db: Db, nowMs: number = Date.now()): Promise<void> {
  if (nowMs - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = nowMs;
  try {
    await sweepEndedShares(db, new Date(nowMs));
  } catch (error) {
    // A failed sweep must never fail the request it rode in on; the next
    // request retries.
    console.warn("share sweep failed", error);
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

export const sharesRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    // Coordinates are sensitive and short-lived; nothing between the browser
    // and Postgres may keep a copy of a positions response.
    c.header("Cache-Control", "no-store");
    await maybeSweep(await getDb());
    await next();
  })

  .get("/", async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();

    const rows = await db
      .select({ share: schema.share, participant: schema.shareParticipant })
      .from(schema.shareParticipant)
      .innerJoin(schema.share, eq(schema.share.id, schema.shareParticipant.shareId))
      .where(
        and(
          eq(schema.shareParticipant.userId, user.id),
          eq(schema.shareParticipant.state, "joined"),
        ),
      )
      .orderBy(desc(schema.share.createdAt))
      .limit(50);

    const visible = rows
      .map(({ share, participant }) => {
        const state = effectiveState(share, now);
        return { share, participant, state };
      })
      .filter(
        ({ state }) =>
          state.status === "active" ||
          (state.endedAt !== null && state.endedAt.getTime() > now.getTime() - RETENTION_MS),
      );

    const ids = visible.map(({ share }) => share.id);
    const counts = ids.length
      ? await db
          .select({ shareId: schema.shareParticipant.shareId, n: count() })
          .from(schema.shareParticipant)
          .where(
            and(
              inArray(schema.shareParticipant.shareId, ids),
              eq(schema.shareParticipant.state, "joined"),
            ),
          )
          .groupBy(schema.shareParticipant.shareId)
      : [];
    const countByShare = new Map(counts.map((row) => [row.shareId, Number(row.n)]));

    const shares = visible
      .sort((a, b) => {
        const activeA = a.state.status === "active" ? 0 : 1;
        const activeB = b.state.status === "active" ? 0 : 1;
        if (activeA !== activeB) return activeA - activeB;
        return b.share.createdAt.getTime() - a.share.createdAt.getTime();
      })
      .slice(0, 20)
      .map(({ share, participant }) =>
        summaryOf(share, participant.role, now, countByShare.get(share.id) ?? 0),
      );

    return c.json({ shares, serverTime: now.toISOString() });
  })

  .post("/", json(createShareBody), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();

    const limit = rateLimit(
      `create:${user.id}`,
      CREATE_LIMIT_PER_HOUR,
      CREATE_WINDOW_MS,
      now.getTime(),
    );
    if (!limit.ok) return rateLimited(c, limit.retryAfterMs);

    const [activeRow] = await db
      .select({ n: count() })
      .from(schema.share)
      .where(
        and(
          eq(schema.share.ownerId, user.id),
          eq(schema.share.status, "active"),
          gt(schema.share.expiresAt, now),
        ),
      );
    if (Number(activeRow?.n ?? 0) >= MAX_ACTIVE_SHARES) {
      return fail(c, 409, "too_many_active_shares");
    }

    const { durationMinutes, inviteCount } = c.req.valid("json");
    const minutes = durationMinutes ?? MAX_OPEN_MINUTES;
    const expiresAt = new Date(now.getTime() + minutes * 60_000);

    const { share, invites } = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.share)
        .values({ ownerId: user.id, durationMinutes, expiresAt })
        .returning();
      const row = created!;

      await tx.insert(schema.shareParticipant).values({
        shareId: row.id,
        userId: user.id,
        role: "owner",
        state: "joined",
        sharing: false,
      });
      await tx.insert(schema.shareEvent).values({
        shareId: row.id,
        actorId: user.id,
        kind: "created",
      });

      const minted: InviteView[] = [];
      for (let index = 0; index < inviteCount; index += 1) {
        minted.push(await createInvite(tx, row, user.id, now));
      }
      return { share: row, invites: minted };
    });

    return c.json(
      {
        share: summaryOf(share, "owner", now, 1),
        invites,
      },
      201,
    );
  })

  .get("/join-preview", query(tokenQuery), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { token } = c.req.valid("query");

    const [invite] = await db
      .select()
      .from(schema.shareInvite)
      .where(eq(schema.shareInvite.tokenHash, hashToken(token)))
      .limit(1);
    if (!invite) return fail(c, 404, "invite_not_found");

    const [shareRow] = await db
      .select()
      .from(schema.share)
      .where(eq(schema.share.id, invite.shareId))
      .limit(1);
    if (!shareRow) return fail(c, 404, "invite_not_found");

    const state = effectiveState(shareRow, now);
    if (state.status === "ended") return fail(c, 409, "share_ended");

    const [mine] = await db
      .select()
      .from(schema.shareParticipant)
      .where(
        and(
          eq(schema.shareParticipant.shareId, shareRow.id),
          eq(schema.shareParticipant.userId, user.id),
        ),
      )
      .limit(1);

    if (mine?.state === "joined") {
      return c.json({
        alreadyMember: true,
        share: summaryOf(shareRow, mine.role, now, await joinedCount(db, shareRow.id)),
      });
    }

    if (invite.revokedAt) return fail(c, 410, "invite_revoked");
    if (invite.acceptedAt && invite.acceptedBy !== user.id) {
      return fail(c, 410, "invite_used");
    }
    if (invite.expiresAt.getTime() <= now.getTime()) {
      return fail(c, 410, "invite_expired");
    }
    if (mine && mine.state !== "joined") return fail(c, 410, "invite_used");

    const [owner] = await db
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, shareRow.ownerId))
      .limit(1);

    return c.json({
      alreadyMember: false,
      inviterName: displayNameFor(owner ?? { name: null, email: null }),
      expiresAt: shareRow.expiresAt.toISOString(),
      remainingMinutes: Math.max(
        0,
        Math.round((shareRow.expiresAt.getTime() - now.getTime()) / 60_000),
      ),
    });
  })

  .post("/join", json(joinBody), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { token } = c.req.valid("json");

    // A link is a bearer secret, so join attempts are limited per account: ten
    // per minute is generous for a real user retrying and useless for spam.
    const attempt = rateLimit(
      `join:${user.id}`,
      JOIN_ATTEMPT_LIMIT,
      JOIN_ATTEMPT_WINDOW_MS,
      now.getTime(),
    );
    if (!attempt.ok) return rateLimited(c, attempt.retryAfterMs);

    const [invite] = await db
      .select()
      .from(schema.shareInvite)
      .where(eq(schema.shareInvite.tokenHash, hashToken(token)))
      .limit(1);
    if (!invite) return fail(c, 404, "invite_not_found");

    const [shareRow] = await db
      .select()
      .from(schema.share)
      .where(eq(schema.share.id, invite.shareId))
      .limit(1);
    if (!shareRow) return fail(c, 404, "invite_not_found");

    const [mine] = await db
      .select()
      .from(schema.shareParticipant)
      .where(
        and(
          eq(schema.shareParticipant.shareId, shareRow.id),
          eq(schema.shareParticipant.userId, user.id),
        ),
      )
      .limit(1);

    // Idempotent for the account that consumed the link, so re-opening it from
    // a history entry lands in the share instead of an error (FR-24).
    if (mine?.state === "joined") {
      return c.json({
        alreadyMember: true,
        share: summaryOf(shareRow, mine.role, now, await joinedCount(db, shareRow.id)),
      });
    }

    const state = effectiveState(shareRow, now);
    if (state.status === "ended") return fail(c, 409, "share_ended");
    if (invite.revokedAt) return fail(c, 410, "invite_revoked");
    if (invite.acceptedAt && invite.acceptedBy !== user.id) {
      return fail(c, 410, "invite_used");
    }
    if (invite.expiresAt.getTime() <= now.getTime()) {
      return fail(c, 410, "invite_expired");
    }
    if (mine && mine.state !== "joined") return fail(c, 410, "invite_used");

    const participants = await joinedCount(db, shareRow.id);
    if (participants >= MAX_PARTICIPANTS) return fail(c, 409, "share_full");

    await db.transaction(async (tx) => {
      await tx.insert(schema.shareParticipant).values({
        shareId: shareRow.id,
        userId: user.id,
        role: "guest",
        state: "joined",
        sharing: false,
      });
      await tx
        .update(schema.shareInvite)
        .set({ acceptedBy: user.id, acceptedAt: now })
        .where(eq(schema.shareInvite.id, invite.id));
      await tx.insert(schema.shareEvent).values({
        shareId: shareRow.id,
        actorId: user.id,
        kind: "joined",
      });
    });

    return c.json({
      alreadyMember: false,
      share: summaryOf(shareRow, "guest", now, participants + 1),
    });
  })

  .get("/:id", param(idParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");

    const participants = await joinedCount(db, id);
    const events = membership.participant.role === "owner" ? await eventsFor(db, id) : undefined;
    return c.json({
      share: summaryOf(
        membership.share,
        membership.participant.role,
        now,
        participants,
        events,
      ),
    });
  })

  .get("/:id/positions", param(idParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (!isActive(membership.share, now)) return fail(c, 409, "share_ended");

    const readLimit = throttle(
      `read:${id}:${user.id}`,
      POSITION_READ_MIN_INTERVAL_MS,
      now.getTime(),
    );
    if (!readLimit.ok) return rateLimited(c, readLimit.retryAfterMs);

    return c.json(await positionsPayload(db, membership.share, membership.participant, now));
  })

  .post("/:id/positions", param(idParam), json(pingBody), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");
    const { lat, lng, accuracy } = c.req.valid("json");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (!isActive(membership.share, now)) return fail(c, 409, "share_ended");
    if (!membership.participant.sharing) return fail(c, 409, "not_sharing");

    const pingLimit = throttle(`ping:${id}:${user.id}`, PING_MIN_INTERVAL_MS, now.getTime());
    if (!pingLimit.ok) return rateLimited(c, pingLimit.retryAfterMs);

    const rounded = (value: number) => Math.round(value * COORD_SCALE) / COORD_SCALE;

    const [updated] = await db
      .update(schema.shareParticipant)
      .set({
        lastLat: rounded(lat),
        lastLng: rounded(lng),
        lastAccuracy: Math.round(accuracy * 10) / 10,
        lastAt: now,
        updatedAt: now,
      })
      // The WHERE clause is the authorisation: joined + publishing + this user.
      .where(
        and(
          eq(schema.shareParticipant.shareId, id),
          eq(schema.shareParticipant.userId, user.id),
          eq(schema.shareParticipant.state, "joined"),
          eq(schema.shareParticipant.sharing, true),
        ),
      )
      .returning({ userId: schema.shareParticipant.userId });
    if (!updated) return fail(c, 409, "not_sharing");

    return c.json(await positionsPayload(db, membership.share, membership.participant, now));
  })

  .patch("/:id/me", param(idParam), json(sharingBody), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");
    const { sharing } = c.req.valid("json");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (!isActive(membership.share, now)) return fail(c, 409, "share_ended");

    const changed = membership.participant.sharing !== sharing;
    const [updated] = await db
      .update(schema.shareParticipant)
      .set(
        sharing
          ? { sharing: true, updatedAt: now }
          : {
              sharing: false,
              lastLat: null,
              lastLng: null,
              lastAccuracy: null,
              lastAt: null,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(schema.shareParticipant.shareId, id),
          eq(schema.shareParticipant.userId, user.id),
          eq(schema.shareParticipant.state, "joined"),
        ),
      )
      .returning();
    if (!updated) return fail(c, 404, "share_not_found");

    if (changed) {
      await db.insert(schema.shareEvent).values({
        shareId: id,
        actorId: user.id,
        kind: sharing ? "resumed" : "paused",
      });
    }

    return c.json(await positionsPayload(db, membership.share, updated, now));
  })

  .post("/:id/end", param(idParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (membership.participant.role !== "owner") return fail(c, 403, "not_owner");

    if (!isActive(membership.share, now)) {
      return c.json({
        share: summaryOf(
          membership.share,
          "owner",
          now,
          await joinedCount(db, id),
          await eventsFor(db, id),
        ),
      });
    }

    const shareRow = await endShare(db, membership.share, user.id, "manual", now);
    return c.json({
      share: summaryOf(shareRow, "owner", now, await joinedCount(db, id), await eventsFor(db, id)),
    });
  })

  .post("/:id/leave", param(idParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");

    if (membership.participant.role === "owner") {
      // There is no ownerless share: leaving as the owner ends it for everyone.
      if (!isActive(membership.share, now)) {
        return c.json({
          share: summaryOf(membership.share, "owner", now, await joinedCount(db, id)),
        });
      }
      const shareRow = await endShare(db, membership.share, user.id, "owner_left", now);
      return c.json({
        share: summaryOf(shareRow, "owner", now, await joinedCount(db, id)),
      });
    }

    await db
      .update(schema.shareParticipant)
      .set({
        state: "left",
        sharing: false,
        lastLat: null,
        lastLng: null,
        lastAccuracy: null,
        lastAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.shareParticipant.shareId, id),
          eq(schema.shareParticipant.userId, user.id),
        ),
      );
    await db.insert(schema.shareEvent).values({ shareId: id, actorId: user.id, kind: "left" });

    return c.json({
      share: summaryOf(
        membership.share,
        "guest",
        now,
        await joinedCount(db, id),
      ),
    });
  })

  .post("/:id/participants/:userId/remove", param(participantParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id, userId } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (membership.participant.role !== "owner") return fail(c, 403, "not_owner");

    const [target] = await db
      .select()
      .from(schema.shareParticipant)
      .where(
        and(
          eq(schema.shareParticipant.shareId, id),
          eq(schema.shareParticipant.userId, userId),
        ),
      )
      .limit(1);
    if (!target || target.state !== "joined") return fail(c, 404, "participant_not_found");
    if (target.role === "owner") return fail(c, 403, "not_permitted");

    await db
      .update(schema.shareParticipant)
      .set({
        state: "removed",
        sharing: false,
        lastLat: null,
        lastLng: null,
        lastAccuracy: null,
        lastAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.shareParticipant.shareId, id),
          eq(schema.shareParticipant.userId, userId),
        ),
      );
    await db.insert(schema.shareEvent).values({ shareId: id, actorId: user.id, kind: "removed" });

    return c.json({
      share: summaryOf(
        membership.share,
        "owner",
        now,
        await joinedCount(db, id),
        await eventsFor(db, id),
      ),
    });
  })

  .post("/:id/invites", param(idParam), async (c) => {
    const user = c.get("user");
    const db = await getDb();
    const now = new Date();
    const { id } = c.req.valid("param");

    const membership = await loadMembership(db, id, user.id);
    if (!membership) return fail(c, 404, "share_not_found");
    if (membership.participant.role !== "owner") return fail(c, 403, "not_owner");
    if (!isActive(membership.share, now)) return fail(c, 409, "share_ended");

    const invites = await db.transaction(async (tx) => {
      // Regenerating replaces any link that has not been used yet.
      await tx
        .update(schema.shareInvite)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.shareInvite.shareId, id),
            isNull(schema.shareInvite.acceptedAt),
            isNull(schema.shareInvite.revokedAt),
          ),
        );
      const invite = await createInvite(tx, membership.share, user.id, now);
      await tx.insert(schema.shareEvent).values({
        shareId: id,
        actorId: user.id,
        kind: "invite_created",
      });
      return [invite];
    });

    return c.json({ invites });
  });

/**
 * End a share for everyone: status, end time, cleared coordinates in one
 * transaction. Shared by the owner's End and Leave actions.
 */
async function endShare(
  db: Db,
  share: ShareRow,
  actorId: string,
  reason: "manual" | "owner_left" | "expired",
  now: Date,
): Promise<ShareRow> {
  const ended = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.share)
      .set({ status: "ended", endedAt: now, endReason: reason, updatedAt: now })
      .where(and(eq(schema.share.id, share.id), eq(schema.share.status, "active")))
      .returning();
    if (!updated) {
      const [current] = await tx
        .select()
        .from(schema.share)
        .where(eq(schema.share.id, share.id))
        .limit(1);
      return current ?? share;
    }
    await tx
      .update(schema.shareParticipant)
      .set({
        sharing: false,
        lastLat: null,
        lastLng: null,
        lastAccuracy: null,
        lastAt: null,
        updatedAt: now,
      })
      .where(eq(schema.shareParticipant.shareId, share.id));
    await tx.insert(schema.shareEvent).values({ shareId: share.id, actorId, kind: "ended" });
    return updated;
  });
  return ended;
}

/* ------------------------------------------------------------------ */
/* People you have shared with before                                 */
/* ------------------------------------------------------------------ */

export const peopleRoutes = new Hono<AppEnv>().get("/recent", async (c) => {
  const user = c.get("user");
  const db = await getDb();

  const mine = await db
    .select({ shareId: schema.shareParticipant.shareId })
    .from(schema.shareParticipant)
    .where(
      and(
        eq(schema.shareParticipant.userId, user.id),
        eq(schema.shareParticipant.state, "joined"),
      ),
    );
  const shareIds = mine.map((row) => row.shareId);
  if (shareIds.length === 0) return c.json({ people: [] as RecentPersonView[] });

  const rows = await db
    .select({
      userId: schema.shareParticipant.userId,
      name: schema.user.name,
      email: schema.user.email,
      joinedAt: schema.shareParticipant.joinedAt,
    })
    .from(schema.shareParticipant)
    .innerJoin(schema.user, eq(schema.user.id, schema.shareParticipant.userId))
    .where(
      and(
        inArray(schema.shareParticipant.shareId, shareIds),
        ne(schema.shareParticipant.userId, user.id),
        eq(schema.shareParticipant.state, "joined"),
      ),
    )
    .orderBy(desc(schema.shareParticipant.joinedAt))
    .limit(60);

  const seen = new Set<string>();
  const people: RecentPersonView[] = [];
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    people.push({
      userId: row.userId,
      displayName: displayNameFor({ name: row.name, email: row.email }),
      lastSharedAt: row.joinedAt.toISOString(),
    });
    if (people.length >= 20) break;
  }

  return c.json({ people });
});
