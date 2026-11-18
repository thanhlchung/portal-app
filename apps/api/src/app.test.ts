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
const { observeOtpSends } = await import("./mail.js");

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
