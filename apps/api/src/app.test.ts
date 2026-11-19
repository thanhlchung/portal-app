/**
 * Integration test: real Postgres (PGlite), real Better Auth, real routes.
 *
 * Nothing is mocked except outbound email — the code is captured through the
 * observer seam rather than read from the database, because the stored code is
 * hashed on purpose.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/pglite/migrator";

const dataDir = mkdtempSync(path.join(tmpdir(), "portal-test-"));
process.env.PGLITE_DIR = dataDir;
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.TRUSTED_ORIGINS = "http://localhost:5173";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const { app } = await import("./app.js");
const { getDb, closeDb } = await import("./db/index.js");
const { observeOtpSends, renderOtpHtml } = await import("./mail.js");

/** address -> most recent code, as observed leaving the mail layer */
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
  // Keep only name=value; attributes are not valid request headers.
  return raw
    .split(",")
    .map((part) => part.split(";")[0]!.trim())
    .filter((part) => part.includes("="))
    .join("; ");
}

/** Drive the real flow: ask for a code, read it, exchange it for a session. */
async function signIn(email: string): Promise<string> {
  const sent = await request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    body: { email, type: "sign-in" },
  });
  assert.equal(sent.status, 200);

  const code = sentCodes.get(email);
  assert.ok(code, `no code was sent to ${email}`);

  const signInResponse = await request("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp: code, name: "Test User" },
  });
  assert.equal(signInResponse.status, 200);
  return cookieFrom(signInResponse);
}

before(async () => {
  await migrate((await getDb()) as never, { migrationsFolder });
});

after(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("health", () => {
  it("is reachable without a session", async () => {
    const response = await request("/api/health");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  });
});

describe("auth gate", () => {
  it("rejects unauthenticated reads", async () => {
    const response = await request("/api/notes");
    assert.equal(response.status, 401);
  });

  it("rejects unauthenticated writes", async () => {
    const response = await request("/api/notes", { method: "POST", body: { title: "x" } });
    assert.equal(response.status, 401);
  });

  it("rejects a wrong code", async () => {
    const response = await request("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: { email: "nobody@example.com", otp: "000000" },
    });
    assert.equal(response.status, 400);
  });
});

describe("email code sign-in", () => {
  it("signs in and returns the session user", async () => {
    const cookie = await signIn("ada@example.com");
    const me = await request("/api/me", { cookie });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: { email: string; emailVerified: boolean } };
    assert.equal(body.user.email, "ada@example.com");
    // Proving control of the mailbox is what the code just proved.
    assert.equal(body.user.emailVerified, true);
  });

  it("does not leak whether an account exists", async () => {
    const response = await request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: { email: "brand-new-person@example.com", type: "sign-in" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
  });
});

describe("notes", () => {
  it("creates, lists and deletes for its owner", async () => {
    const cookie = await signIn("owner@example.com");

    const created = await request("/api/notes", {
      method: "POST",
      body: { title: "Ship the vertical slice" },
      cookie,
    });
    assert.equal(created.status, 201);
    const { note } = (await created.json()) as { note: { id: string; body: string } };
    // zod default fills the omitted body.
    assert.equal(note.body, "");

    const listed = await request("/api/notes", { cookie });
    const { notes } = (await listed.json()) as { notes: { id: string }[] };
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.id, note.id);

    const deleted = await request(`/api/notes/${note.id}`, { method: "DELETE", cookie });
    assert.equal(deleted.status, 200);

    const after_ = await request("/api/notes", { cookie });
    assert.equal(((await after_.json()) as { notes: unknown[] }).notes.length, 0);
  });

  it("rejects a blank title", async () => {
    const cookie = await signIn("validator@example.com");
    const response = await request("/api/notes", {
      method: "POST",
      body: { title: "   " },
      cookie,
    });
    assert.equal(response.status, 400);
  });

  it("keeps users' notes separate", async () => {
    const alice = await signIn("alice@example.com");
    const bob = await signIn("bob@example.com");

    const created = await request("/api/notes", {
      method: "POST",
      body: { title: "alice only" },
      cookie: alice,
    });
    const { note } = (await created.json()) as { note: { id: string } };

    const bobList = await request("/api/notes", { cookie: bob });
    assert.equal(((await bobList.json()) as { notes: unknown[] }).notes.length, 0);

    // Someone else's id must not be addressable, not even to learn it exists.
    const patch = await request(`/api/notes/${note.id}`, {
      method: "PATCH",
      body: { title: "hijacked" },
      cookie: bob,
    });
    assert.equal(patch.status, 404);

    const remove = await request(`/api/notes/${note.id}`, { method: "DELETE", cookie: bob });
    assert.equal(remove.status, 404);
  });
});

describe("email template", () => {
  const html = renderOtpHtml("123456", 10);

  it("keeps the code as one contiguous run", () => {
    // Gmail's copy-code detection and long-press selection both depend on the
    // digits being adjacent text, not split across elements.
    assert.ok(html.includes(">123456<"), "code should appear as a single text node");
    const split = /1\D{0,20}2\D{0,20}3\D{0,20}4\D{0,20}5\D{0,20}6/;
    assert.ok(!split.test(html.replace(/>123456</g, "")), "code must not be interleaved");
  });

  it("ships no script and no remote images", () => {
    // Email clients strip scripts; an external image would also break the code
    // for anyone with images blocked, which is most people by default.
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<img/i.test(html));
  });

  it("tells the user the code is copyable and how long it lasts", () => {
    assert.ok(/press and hold/i.test(html));
    assert.ok(/expires in 10 minutes/i.test(html));
  });
});

interface BoardBody {
  scores: {
    id: string;
    playerName: string;
    score: number;
    level: number;
    createdAt: string;
    isYou: boolean;
  }[];
  you: { score: number; level: number; createdAt: string; rank: number } | null;
}

async function board(cookie: string): Promise<BoardBody> {
  const response = await request("/api/scores", { cookie });
  assert.equal(response.status, 200);
  return (await response.json()) as BoardBody;
}

/**
 * Tests run in declaration order against one shared database, so these build on
 * each other deliberately: the ordering case depends on rows written by the
 * earlier cases. Every assertion is still stated in terms of the response, not
 * of hardcoded global positions.
 */
describe("scores", () => {
  it("rejects unauthenticated reads and writes", async () => {
    assert.equal((await request("/api/scores")).status, 401);
    assert.equal(
      (await request("/api/scores", { method: "POST", body: { score: 100, level: 1 } })).status,
      401,
    );
  });

  it("records a run, defaults the name and reports a rank", async () => {
    const cookie = await signIn("scorer@example.com");
    const response = await request("/api/scores", {
      method: "POST",
      body: { score: 1200, level: 3 },
      cookie,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      score: { playerName: string; score: number; level: number; createdAt: string };
      rank: number;
    };
    // The sign-in flow above names this account "Test User".
    assert.equal(body.score.playerName, "Test User");
    assert.equal(body.score.score, 1200);
    assert.equal(body.score.level, 3);
    assert.equal(typeof body.score.createdAt, "string");
    assert.equal(body.rank, 1);
  });

  it("accepts a nickname and trims it", async () => {
    const cookie = await signIn("nickname@example.com");
    const response = await request("/api/scores", {
      method: "POST",
      body: { score: 50, level: 1, playerName: "  ACE  " },
      cookie,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { score: { playerName: string } };
    assert.equal(body.score.playerName, "ACE");
  });

  it("rejects scores that could not have been earned", async () => {
    const cookie = await signIn("cheater@example.com");
    const rejected = [
      { score: -1, level: 1 },
      { score: 12.5, level: 1 },
      { score: 1_000_001, level: 1 },
      { score: 10, level: 0 },
      { score: 10, level: 101 },
      { score: 10, level: 1, playerName: "x".repeat(25) },
      { score: 10, level: 1, playerName: "   " },
      { score: "1000", level: 1 },
    ];
    for (const body of rejected) {
      const response = await request("/api/scores", { method: "POST", body, cookie });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  it("orders the board by score and reports the caller's best run", async () => {
    const low = await signIn("low@example.com");
    await request("/api/scores", {
      method: "POST",
      body: { score: 300, level: 1 },
      cookie: low,
    });
    await request("/api/scores", {
      method: "POST",
      body: { score: 800, level: 2 },
      cookie: low,
    });

    const high = await signIn("high@example.com");
    await request("/api/scores", {
      method: "POST",
      body: { score: 2500, level: 5 },
      cookie: high,
    });

    const { scores, you } = await board(low);

    const values = scores.map((entry) => entry.score);
    assert.deepEqual(values, [...values].sort((a, b) => b - a), "board must be descending");
    assert.equal(values[0], 2500);

    assert.ok(you, "a player with runs must get a best entry");
    // Best run of *this* player, not the best run overall.
    assert.equal(you.score, 800);
    assert.equal(you.level, 2);
    // Rank counts everything that beat this run, so it may point past the
    // returned page when the board is longer than one page.
    assert.equal(you.rank, scores.filter((entry) => entry.score > 800).length + 1);

    assert.equal(scores.find((entry) => entry.score === 800)?.isYou, true);
    assert.equal(scores.find((entry) => entry.score === 2500)?.isYou, false);
  });

  it("never exposes a player's email address", async () => {
    const cookie = await signIn("private@example.com");
    await request("/api/scores", {
      method: "POST",
      body: { score: 42, level: 1 },
      cookie,
    });
    const text = JSON.stringify(await board(cookie));
    // The board is visible to every signed-in player, so the payload may only
    // carry nicknames — never addresses, not even as a fallback.
    assert.ok(!text.includes("@example.com"), "email address leaked into the board");
  });

  it("gives equal scores the same standing, ordered by time", async () => {
    const first = await signIn("tie-a@example.com");
    await request("/api/scores", {
      method: "POST",
      body: { score: 900, level: 2 },
      cookie: first,
    });
    const second = await signIn("tie-b@example.com");
    await request("/api/scores", {
      method: "POST",
      body: { score: 900, level: 2 },
      cookie: second,
    });

    const { scores } = await board(second);
    const tied = scores.filter((entry) => entry.score === 900);
    assert.equal(tied.length, 2);
    // The earlier run is listed first, so a new equal score never demotes it.
    assert.equal(tied[0]!.isYou, false);
    assert.equal(tied[1]!.isYou, true);
  });

  it("caps the board at twenty entries, keeping the highest", async () => {
    const cookie = await signIn("bulk@example.com");
    for (let i = 1; i <= 22; i += 1) {
      const response = await request("/api/scores", {
        method: "POST",
        body: { score: 100_000 + i, level: 10 },
        cookie,
      });
      assert.equal(response.status, 201);
    }

    const { scores, you } = await board(cookie);
    assert.equal(scores.length, 20);
    assert.equal(scores[0]!.score, 100_022);
    assert.equal(scores[0]!.level, 10);
    // A run outside the returned page still has a real rank.
    assert.ok(you);
    assert.equal(you.score, 100_022);
    assert.equal(you.rank, 1);
  });
});
