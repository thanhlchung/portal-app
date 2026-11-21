/**
 * Live Share integration tests: real Postgres (PGlite), real Better Auth, real
 * routes. These encode the invariants in docs/LIVE-SHARE-REQUIREMENTS.md §7.5
 * and §11.1 — especially the ones a code review cannot see: that an ended or
 * expired share can never serve a coordinate, that a link is single-use, that a
 * non-member sees 404 rather than learning a share exists, and that the purge
 * actually runs.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/pglite/migrator";

const dataDir = mkdtempSync(path.join(tmpdir(), "portal-shares-test-"));
process.env.PGLITE_DIR = dataDir;
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.TRUSTED_ORIGINS = "http://localhost:5173";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const { app } = await import("./app.js");
const { closeDb, getDb, schema } = await import("./db/index.js");
const { observeOtpSends } = await import("./mail.js");
const { resetLimitsForTests } = await import("./limits.js");
const { resetSweepState, MAX_PARTICIPANTS, RETENTION_MS } = await import(
  "./routes/shares.js"
);

import type {
  InviteView,
  ParticipantView,
  ShareSummary,
} from "./routes/shares.js";

/** address -> most recent code, observed leaving the mail layer. */
const sentCodes = new Map<string, string>();
observeOtpSends((email, code) => sentCodes.set(email, code));

async function request(
  path_: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  return app.request(path_, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie");
  assert.ok(raw, "expected a session cookie");
  return raw
    .split(",")
    .map((part) => part.split(";")[0]!.trim())
    .filter((part) => part.includes("="))
    .join("; ");
}

async function signIn(email: string, name = "Test User"): Promise<string> {
  const sent = await request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    body: { email, type: "sign-in" },
  });
  assert.equal(sent.status, 200);

  const code = sentCodes.get(email);
  assert.ok(code, `no code was sent to ${email}`);

  const signed = await request("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp: code, name },
  });
  assert.equal(signed.status, 200);
  return cookieFrom(signed);
}

async function asJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface CreateBody {
  share: ShareSummary;
  invites: InviteView[];
}

interface SummaryBody {
  share: ShareSummary;
}

interface PositionsBody {
  share: ShareSummary;
  participants: ParticipantView[];
}

interface JoinBody {
  alreadyMember: boolean;
  share: ShareSummary;
}

let counter = 0;
function emailFor(label: string): string {
  counter += 1;
  return `${label}-${counter}@example.com`;
}

async function createShare(
  cookie: string,
  options: { durationMinutes?: 15 | 30 | 60 | 120 | null; inviteCount?: number } = {},
): Promise<CreateBody> {
  const response = await request("/api/shares", {
    method: "POST",
    body: options,
    cookie,
  });
  assert.equal(response.status, 201, `create failed: ${await response.clone().text()}`);
  return asJson<CreateBody>(response);
}

async function join(cookie: string, token: string): Promise<Response> {
  return request("/api/shares/join", { method: "POST", body: { token }, cookie });
}

async function setSharing(cookie: string, shareId: string, sharing: boolean) {
  const response = await request(`/api/shares/${shareId}/me`, {
    method: "PATCH",
    body: { sharing },
    cookie,
  });
  assert.equal(response.status, 200, `sharing patch failed: ${await response.clone().text()}`);
  return asJson<PositionsBody>(response);
}

async function ping(cookie: string, shareId: string, fix = { lat: 51.5074, lng: -0.1278, accuracy: 12.5 }) {
  return request(`/api/shares/${shareId}/positions`, {
    method: "POST",
    body: fix,
    cookie,
  });
}

async function positions(cookie: string, shareId: string) {
  return request(`/api/shares/${shareId}/positions`, { cookie });
}

before(async () => {
  resetLimitsForTests();
  await migrate((await getDb()) as never, { migrationsFolder });
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("live share: auth gate", () => {
  it("rejects every share route without a session", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    assert.equal((await request("/api/shares")).status, 401);
    assert.equal((await request("/api/shares", { method: "POST", body: {} })).status, 401);
    assert.equal((await request(`/api/shares/${id}`)).status, 401);
    assert.equal((await request(`/api/shares/${id}/positions`)).status, 401);
    assert.equal(
      (await request(`/api/shares/${id}/positions`, {
        method: "POST",
        body: { lat: 1, lng: 1, accuracy: 5 },
      })).status,
      401,
    );
    assert.equal((await request("/api/shares/join-preview?token=abcdefghijklmnop")).status, 401);
  });
});

describe("live share: creating", () => {
  it("creates a share with the owner as its first participant and one link", async () => {
    const owner = await signIn(emailFor("create-owner"), "Owner One");
    const created = await createShare(owner, { durationMinutes: 30 });
    const now = new Date(created.share.serverTime).getTime();

    assert.equal(created.share.role, "owner");
    assert.equal(created.share.status, "active");
    assert.equal(created.share.participantCount, 1);
    assert.equal(created.invites.length, 1);
    assert.match(created.invites[0]!.url, /^\/join\/[A-Za-z0-9_-]{20,}$/);
    assert.equal(
      new Date(created.share.expiresAt).getTime() - now,
      30 * 60_000,
      "expiresAt is created + the chosen duration",
    );

    const summary = await request(`/api/shares/${created.share.id}`, { cookie: owner });
    assert.equal(summary.status, 200);
    const body = await asJson<SummaryBody>(summary);
    assert.equal(body.share.participantCount, 1);
    assert.equal(body.share.role, "owner");
    assert.ok(body.share.serverTime, "summary carries the server clock");

    const listed = await request("/api/shares", { cookie: owner });
    assert.equal(listed.status, 200);
    const list = await asJson<{ shares: ShareSummary[] }>(listed);
    const mine = list.shares.find((share) => share.id === created.share.id);
    assert.ok(mine, "the new share is in the owner's list");
    assert.equal(mine.status, "active");
  });

  it("caps an open-ended share at eight hours and mints one link per recipient", async () => {
    const owner = await signIn(emailFor("open-owner"));
    const created = await createShare(owner, { durationMinutes: null, inviteCount: 3 });
    const now = new Date(created.share.serverTime).getTime();

    assert.equal(created.invites.length, 3);
    assert.equal(new Set(created.invites.map((invite) => invite.token)).size, 3);
    assert.equal(
      new Date(created.share.expiresAt).getTime() - now,
      8 * 60 * 60_000,
      "an open share expires after eight hours",
    );
  });

  it("rejects a body that is not in the preset set", async () => {
    const owner = await signIn(emailFor("bad-duration"));
    const response = await request("/api/shares", {
      method: "POST",
      body: { durationMinutes: 7 },
      cookie: owner,
    });
    assert.equal(response.status, 400);
  });
});

describe("live share: membership is the read authorisation", () => {
  it("returns 404 to a non-member on summary and positions", async () => {
    const owner = await signIn(emailFor("iso-owner"));
    const stranger = await signIn(emailFor("iso-stranger"));
    const created = await createShare(owner, { durationMinutes: 15 });

    assert.equal((await request(`/api/shares/${created.share.id}`, { cookie: stranger })).status, 404);
    assert.equal((await positions(stranger, created.share.id)).status, 404);
    assert.equal(
      (await request(`/api/shares/${created.share.id}/end`, { method: "POST", cookie: stranger }))
        .status,
      404,
    );
  });

  it("lets a guest read but not end or remove people", async () => {
    const owner = await signIn(emailFor("role-owner"));
    const guest = await signIn(emailFor("role-guest"));
    const created = await createShare(owner, { durationMinutes: 15 });
    const joined = await join(guest, created.invites[0]!.token);
    assert.equal(joined.status, 200);

    assert.equal((await request(`/api/shares/${created.share.id}`, { cookie: guest })).status, 200);
    const end = await request(`/api/shares/${created.share.id}/end`, { method: "POST", cookie: guest });
    assert.equal(end.status, 403);
    assert.equal((await asJson<{ error: string }>(end)).error, "not_owner");

    const guestId = (await asJson<{ user: { id: string } }>(
      await request("/api/me", { cookie: guest }),
    )).user.id;
    const remove = await request(`/api/shares/${created.share.id}/participants/${guestId}/remove`, {
      method: "POST",
      cookie: guest,
    });
    assert.equal(remove.status, 403);
  });
});

describe("live share: join links", () => {
  it("joins once, is idempotent for the same account, and refuses a second account", async () => {
    const owner = await signIn(emailFor("link-owner"), "Sam");
    const first = await signIn(emailFor("link-first"), "Ana");
    const second = await signIn(emailFor("link-second"), "Dev");
    const created = await createShare(owner, { durationMinutes: 30 });
    const token = created.invites[0]!.token;

    const preview = await request(`/api/shares/join-preview?token=${token}`, { cookie: first });
    assert.equal(preview.status, 200);
    const previewBody = await asJson<{ inviterName: string; remainingMinutes: number }>(preview);
    assert.equal(previewBody.inviterName, "Sam");
    assert.ok(previewBody.remainingMinutes > 0 && previewBody.remainingMinutes <= 30);

    const joined = await join(first, token);
    assert.equal(joined.status, 200);
    const joinBody = await asJson<JoinBody>(joined);
    assert.equal(joinBody.alreadyMember, false);
    assert.equal(joinBody.share.participantCount, 2);

    const again = await join(first, token);
    assert.equal(again.status, 200);
    assert.equal((await asJson<JoinBody>(again)).alreadyMember, true);

    const stolen = await join(second, token);
    assert.equal(stolen.status, 410);
    assert.equal((await asJson<{ error: string }>(stolen)).error, "invite_used");

    const unknown = await join(second, "x".repeat(24));
    assert.equal(unknown.status, 404);
  });

  it("revokes the unaccepted link when the owner regenerates it", async () => {
    const owner = await signIn(emailFor("regen-owner"));
    const guest = await signIn(emailFor("regen-guest"));
    const created = await createShare(owner, { durationMinutes: 30 });
    const oldToken = created.invites[0]!.token;

    const minted = await request(`/api/shares/${created.share.id}/invites`, {
      method: "POST",
      cookie: owner,
    });
    assert.equal(minted.status, 200);
    const fresh = (await asJson<{ invites: InviteView[] }>(minted)).invites[0]!;

    const revoked = await join(guest, oldToken);
    assert.equal(revoked.status, 410);
    assert.equal((await asJson<{ error: string }>(revoked)).error, "invite_revoked");

    assert.equal((await join(guest, fresh.token)).status, 200);
  });

  it("rejects an expired link", async () => {
    const owner = await signIn(emailFor("expire-link-owner"));
    const guest = await signIn(emailFor("expire-link-guest"));
    const created = await createShare(owner, { durationMinutes: 15 });
    const db = await getDb();
    await db
      .update(schema.shareInvite)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareInvite.shareId, created.share.id));

    const response = await join(guest, created.invites[0]!.token);
    assert.equal(response.status, 410);
    assert.equal((await asJson<{ error: string }>(response)).error, "invite_expired");
  });

  it("lists co-participants as recent people", async () => {
    const owner = await signIn(emailFor("recent-owner"), "Riley");
    const guest = await signIn(emailFor("recent-guest"), "Ana");
    const created = await createShare(owner, { durationMinutes: 15 });
    await join(guest, created.invites[0]!.token);

    const response = await request("/api/people/recent", { cookie: guest });
    assert.equal(response.status, 200);
    const body = await asJson<{ people: { userId: string; displayName: string }[] }>(response);
    assert.ok(body.people.some((person) => person.displayName === "Riley"));
    // Never an email address, even though the user table stores one.
    assert.ok(!JSON.stringify(body).includes("@"));
  });
});

describe("live share: publishing", () => {
  it("publishes server-stamped, rounded positions for the caller only", async () => {
    const owner = await signIn(emailFor("publish-owner"), "Owner");
    const guest = await signIn(emailFor("publish-guest"), "Guest");
    const created = await createShare(owner, { durationMinutes: 30 });
    await join(guest, created.invites[0]!.token);

    await setSharing(guest, created.share.id, true);
    const response = await ping(guest, created.share.id, {
      lat: 51.5074129,
      lng: -0.1278123,
      accuracy: 12.349,
    });
    assert.equal(response.status, 200);
    const payload = await asJson<PositionsBody>(response);

    const mine = payload.participants.find((participant) => participant.displayName === "Guest")!;
    assert.equal(mine.lat, 51.507413, "rounded to six decimal places");
    assert.equal(mine.lng, -0.127812);
    assert.equal(mine.accuracy, 12.3, "accuracy rounded to 0.1 m");
    assert.ok(mine.lastAt, "position has a server timestamp");
    const drift = Math.abs(
      new Date(payload.share.serverTime).getTime() - new Date(mine.lastAt!).getTime(),
    );
    assert.ok(drift < 5_000, "lastAt is the server clock, not the device clock");

    // A client-supplied userId cannot write someone else's row: the id comes
    // from the session, and unknown body fields are stripped by the schema.
    await setSharing(owner, created.share.id, true);
    const injected = await request(`/api/shares/${created.share.id}/positions`, {
      method: "POST",
      body: { lat: 1, lng: 1, accuracy: 5, userId: mine.userId, lastAt: "2020-01-01T00:00:00.000Z" },
      cookie: owner,
    });
    assert.equal(injected.status, 200);
    const after = await asJson<PositionsBody>(injected);
    const guestRow = after.participants.find((participant) => participant.userId === mine.userId)!;
    assert.equal(guestRow.lat, 51.507413, "the guest's row is untouched");
    const ownerRow = after.participants.find((participant) => participant.isYou)!;
    assert.equal(ownerRow.lat, 1, "the caller's own row is the only one written");
  });

  it("clears the published position on pause and refuses pings while not sharing", async () => {
    const owner = await signIn(emailFor("pause-owner"));
    const guest = await signIn(emailFor("pause-guest"));
    const created = await createShare(owner, { durationMinutes: 30 });
    await join(guest, created.invites[0]!.token);

    const publishing = await setSharing(guest, created.share.id, true);
    assert.equal(
      publishing.participants.find((participant) => participant.isYou)!.sharing,
      true,
    );
    assert.equal((await ping(guest, created.share.id)).status, 200);

    const cleared = await setSharing(guest, created.share.id, false);
    const me = cleared.participants.find((participant) => participant.isYou)!;
    assert.equal(me.sharing, false);
    assert.equal(me.lat, null);
    assert.equal(me.lng, null);
    assert.equal(me.lastAt, null);

    const refused = await ping(guest, created.share.id);
    assert.equal(refused.status, 409);
    assert.equal((await asJson<{ error: string }>(refused)).error, "not_sharing");
  });

  it("throttles pings to one per five seconds", async () => {
    const owner = await signIn(emailFor("throttle-owner"));
    const created = await createShare(owner, { durationMinutes: 15 });
    await setSharing(owner, created.share.id, true);

    assert.equal((await ping(owner, created.share.id)).status, 200);
    const second = await ping(owner, created.share.id);
    assert.equal(second.status, 429);
    assert.ok(second.headers.get("retry-after"), "429 carries Retry-After");
  });

  it("validates coordinate bounds", async () => {
    const owner = await signIn(emailFor("bounds-owner"));
    const created = await createShare(owner, { durationMinutes: 15 });
    await setSharing(owner, created.share.id, true);

    const bad = await ping(owner, created.share.id, { lat: 90.5, lng: 0, accuracy: 5 });
    assert.equal(bad.status, 400);
    const negativeAccuracy = await ping(owner, created.share.id, { lat: 0, lng: 0, accuracy: -1 });
    assert.equal(negativeAccuracy.status, 400);
  });
});

describe("live share: ending, expiry and retention", () => {
  it("ends the share, clears every coordinate, and refuses pings afterwards", async () => {
    const owner = await signIn(emailFor("end-owner"));
    const guest = await signIn(emailFor("end-guest"));
    const created = await createShare(owner, { durationMinutes: 30 });
    await join(guest, created.invites[0]!.token);
    await setSharing(guest, created.share.id, true);
    assert.equal((await ping(guest, created.share.id)).status, 200);

    const ended = await request(`/api/shares/${created.share.id}/end`, {
      method: "POST",
      cookie: owner,
    });
    assert.equal(ended.status, 200);
    const endedBody = await asJson<SummaryBody>(ended);
    assert.equal(endedBody.share.status, "ended");
    assert.equal(endedBody.share.endReason, "manual");
    assert.ok(endedBody.share.endedAt);

    assert.equal((await positions(guest, created.share.id)).status, 409);
    assert.equal((await ping(guest, created.share.id)).status, 409);

    // Retained as a summary, but not a single coordinate survives.
    const summary = await request(`/api/shares/${created.share.id}`, { cookie: owner });
    assert.equal(summary.status, 200);
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.shareParticipant)
      .where(eq(schema.shareParticipant.shareId, created.share.id));
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.lastLat, null);
      assert.equal(row.lastLng, null);
      assert.equal(row.lastAt, null);
      assert.equal(row.sharing, false);
    }

    const again = await request(`/api/shares/${created.share.id}/end`, {
      method: "POST",
      cookie: owner,
    });
    assert.equal(again.status, 200, "ending is idempotent");
  });

  it("treats an expired share as ended without waiting for a sweep", async () => {
    const owner = await signIn(emailFor("expiry-owner"));
    const created = await createShare(owner, { durationMinutes: 15 });
    await setSharing(owner, created.share.id, true);
    const db = await getDb();
    const past = new Date(Date.now() - 60_000);
    await db
      .update(schema.share)
      .set({ expiresAt: past })
      .where(eq(schema.share.id, created.share.id));

    const summary = await request(`/api/shares/${created.share.id}`, { cookie: owner });
    assert.equal(summary.status, 200);
    const body = await asJson<SummaryBody>(summary);
    assert.equal(body.share.status, "ended");
    assert.equal(body.share.endReason, "expired");

    assert.equal((await positions(owner, created.share.id)).status, 409);
    assert.equal((await ping(owner, created.share.id)).status, 409);

    // A sweep flips the row itself, so the state is consistent for any reader.
    resetSweepState();
    const { sweepEndedShares } = await import("./routes/shares.js");
    await sweepEndedShares(db);
    const [row] = await db
      .select()
      .from(schema.share)
      .where(eq(schema.share.id, created.share.id));
    assert.equal(row!.status, "ended");
    assert.equal(row!.endReason, "expired");
  });

  it("purges an ended share once it is older than 24 hours", async () => {
    const owner = await signIn(emailFor("purge-owner"));
    const created = await createShare(owner, { durationMinutes: 15 });
    await request(`/api/shares/${created.share.id}/end`, { method: "POST", cookie: owner });

    const db = await getDb();
    await db
      .update(schema.share)
      .set({ endedAt: new Date(Date.now() - RETENTION_MS - 60_000) })
      .where(eq(schema.share.id, created.share.id));

    resetSweepState();
    const listed = await request("/api/shares", { cookie: owner });
    assert.equal(listed.status, 200);
    const list = await asJson<{ shares: ShareSummary[] }>(listed);
    assert.ok(!list.shares.some((share) => share.id === created.share.id));

    const summary = await request(`/api/shares/${created.share.id}`, { cookie: owner });
    assert.equal(summary.status, 404);
  });
});

describe("live share: leaving and removal", () => {
  it("revokes access immediately when a guest leaves or is removed", async () => {
    const owner = await signIn(emailFor("leave-owner"));
    const guestA = await signIn(emailFor("leave-a"));
    const guestB = await signIn(emailFor("leave-b"));
    const created = await createShare(owner, { durationMinutes: 30, inviteCount: 2 });
    await join(guestA, created.invites[0]!.token);
    await join(guestB, created.invites[1]!.token);

    const left = await request(`/api/shares/${created.share.id}/leave`, {
      method: "POST",
      cookie: guestA,
    });
    assert.equal(left.status, 200);
    assert.equal((await asJson<SummaryBody>(left)).share.participantCount, 2);
    assert.equal((await positions(guestA, created.share.id)).status, 404);
    assert.equal((await request(`/api/shares/${created.share.id}`, { cookie: guestA })).status, 404);

    const guestBId = (await asJson<{ user: { id: string } }>(
      await request("/api/me", { cookie: guestB }),
    )).user.id;
    const removed = await request(
      `/api/shares/${created.share.id}/participants/${guestBId}/remove`,
      { method: "POST", cookie: owner },
    );
    assert.equal(removed.status, 200);
    assert.equal((await asJson<SummaryBody>(removed)).share.participantCount, 1);
    assert.equal((await positions(guestB, created.share.id)).status, 404);
  });

  it("ends the share when the owner leaves", async () => {
    const owner = await signIn(emailFor("owner-leave"));
    const created = await createShare(owner, { durationMinutes: 30 });
    const left = await request(`/api/shares/${created.share.id}/leave`, {
      method: "POST",
      cookie: owner,
    });
    assert.equal(left.status, 200);
    const body = await asJson<SummaryBody>(left);
    assert.equal(body.share.status, "ended");
    assert.equal(body.share.endReason, "owner_left");
  });
});

describe("live share: limits", () => {
  it("enforces the participant cap", async () => {
    const owner = await signIn(emailFor("cap-owner"));
    const created = await createShare(owner, {
      durationMinutes: 60,
      inviteCount: MAX_PARTICIPANTS - 1,
    });
    assert.equal(created.invites.length, MAX_PARTICIPANTS - 1);

    for (let index = 0; index < MAX_PARTICIPANTS - 1; index += 1) {
      const guest = await signIn(emailFor(`cap-guest-${index}`));
      const joined = await join(guest, created.invites[index]!.token);
      assert.equal(joined.status, 200, `guest ${index} should join`);
    }

    const extra = await signIn(emailFor("cap-extra"));
    const minted = await request(`/api/shares/${created.share.id}/invites`, {
      method: "POST",
      cookie: owner,
    });
    const extraToken = (await asJson<{ invites: InviteView[] }>(minted)).invites[0]!;
    const refused = await join(extra, extraToken.token);
    assert.equal(refused.status, 409);
    assert.equal((await asJson<{ error: string }>(refused)).error, "share_full");
  });

  it("enforces the per-hour create limit", async () => {
    const owner = await signIn(emailFor("create-limit-owner"));
    for (let index = 0; index < 10; index += 1) {
      const created = await createShare(owner, { durationMinutes: 15 });
      const ended = await request(`/api/shares/${created.share.id}/end`, {
        method: "POST",
        cookie: owner,
      });
      assert.equal(ended.status, 200);
    }
    const eleventh = await request("/api/shares", {
      method: "POST",
      body: { durationMinutes: 15 },
      cookie: owner,
    });
    assert.equal(eleventh.status, 429);
    assert.equal((await asJson<{ error: string }>(eleventh)).error, "rate_limited");
  });
});

describe("live share: privacy invariants", () => {
  it("never returns an email address in a share payload", async () => {
    const owner = await signIn(emailFor("privacy-owner"), "Sam");
    const guest = await signIn(emailFor("privacy-guest"), "Ana");
    const created = await createShare(owner, { durationMinutes: 15 });
    await join(guest, created.invites[0]!.token);
    await setSharing(guest, created.share.id, true);
    assert.equal((await ping(guest, created.share.id)).status, 200);

    const response = await positions(owner, created.share.id);
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.ok(!raw.includes("@"), "no email address in a positions payload");
    const payload = JSON.parse(raw) as PositionsBody;
    assert.deepEqual(
      payload.participants.map((participant) => participant.displayName).sort(),
      ["Ana", "Sam"],
    );
  });

  it("cascades an account deletion through hosted shares and memberships", async () => {
    const owner = await signIn(emailFor("delete-owner"));
    const guest = await signIn(emailFor("delete-guest"));
    const created = await createShare(owner, { durationMinutes: 15 });
    await join(guest, created.invites[0]!.token);

    const ownerId = (await asJson<{ user: { id: string } }>(
      await request("/api/me", { cookie: owner }),
    )).user.id;

    const db = await getDb();
    await db.delete(schema.user).where(eq(schema.user.id, ownerId));

    const shares = await db
      .select({ id: schema.share.id })
      .from(schema.share)
      .where(eq(schema.share.ownerId, ownerId));
    assert.equal(shares.length, 0);

    const memberships = await db
      .select({ userId: schema.shareParticipant.userId })
      .from(schema.shareParticipant)
      .where(eq(schema.shareParticipant.shareId, created.share.id));
    assert.equal(memberships.length, 0);
  });
});
